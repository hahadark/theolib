//! 주소의 zip 파일에서 자료 받기. 전체를 받지 않고 Range 로 끝 기록과 중앙 목록만 읽어 항목을 나열하고,
//! 고른 항목의 구간만 받아 풀어 자료 파일 리더(localfiles)로 통합 DB에 넣는다.
//! 구글 드라이브 공유 링크도 받는다(검사 안내 HTML 이면 confirm·uuid 로 다시 요청).
use crate::localfiles::{self, LocalItem};
use crate::secret;
use crate::source::{self, SID, SrcInfo, get_range, hex, push_unique, save_state, source_key};
use crate::Home;
use anyhow::{Result, bail};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug)]
pub struct ZEntry {
    pub name: String,
    pub base: String,
    pub method: u16,
    pub crc: u32,
    pub csize: u64,
    pub usize: u64,
    pub offset: u64,
    pub unsupported: String,
}

/// 드라이브 링크 4가지 꼴에서 파일 ID
pub fn drive_id(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if host != "drive.google.com" && host != "drive.usercontent.google.com" && host != "docs.google.com" {
        return None;
    }
    if let Some(r) = path.strip_prefix("file/d/") {
        let id: String = r.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        return (!id.is_empty()).then_some(id);
    }
    let q = path.split_once('?')?.1;
    let q = q.split('#').next().unwrap_or(q);
    q.split('&').find_map(|kv| kv.strip_prefix("id=")).map(|v| v.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect::<String>()).filter(|s| !s.is_empty())
}

pub fn drive_url(id: &str) -> String {
    format!("https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t")
}

/// 검사 안내 HTML 의 숨은 값(confirm, uuid)을 붙인 주소. 없으면 None.
pub fn parse_confirm(html: &str, id: &str) -> Option<String> {
    let val = |name: &str| -> Option<String> {
        let i = html.find(&format!("name=\"{name}\""))?;
        let tail = &html[i..];
        let v = tail.split("value=\"").nth(1)?.split('"').next()?;
        Some(v.to_string())
    };
    let confirm = val("confirm")?;
    let mut u = format!("https://drive.usercontent.google.com/download?id={id}&export=download&confirm={confirm}");
    if let Some(uuid) = val("uuid") {
        u.push_str(&format!("&uuid={uuid}"));
    }
    Some(u)
}

/// 이 주소를 zip 출처로 볼지(주소가 .zip 으로 끝나거나 드라이브 링크)
pub fn looks_zip(url: &str) -> bool {
    if source::parse_github(url).is_some() {
        return false;
    }
    let path = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();
    path.ends_with(".zip") || drive_id(url).is_some() && !path.ends_with(".json")
}

/// 서버 응답이 HTML(안내·권한 없음·한도 초과)이면 true
fn is_html(r: &ureq::http::Response<ureq::Body>) -> bool {
    r.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|v| v.to_lowercase().contains("text/html")).unwrap_or(false)
}

/// 실제 요청 주소(드라이브면 변환·확인 절차 반영)
fn resolve(url: &str) -> Result<String> {
    let Some(id) = drive_id(url) else { return Ok(url.to_string()) };
    let u = drive_url(&id);
    let r = get_range(&u, "bytes=0-3")?;
    if !is_html(&r) {
        return Ok(u);
    }
    let mut body = String::new();
    r.into_body().into_reader().take(1 << 20).read_to_string(&mut body).ok();
    let Some(u2) = parse_confirm(&body, &id) else { bail!("드라이브 링크 권한 또는 내려받기 한도 문제입니다(HTML 응답).") };
    let r = get_range(&u2, "bytes=0-3")?;
    if is_html(&r) {
        bail!("드라이브 링크 권한 또는 내려받기 한도 문제입니다(HTML 응답).");
    }
    Ok(u2)
}

pub struct Zip {
    pub url: String,
    /// Range 를 받는 서버면 None, 아니면 전체를 받아 둔 임시 파일
    local: Option<std::path::PathBuf>,
    pub size: u64,
    pub entries: Vec<ZEntry>,
    pub fetched: u64,
    pub ranged: bool,
}

fn u16le(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn decode_name(raw: &[u8], utf8: bool) -> String {
    let s = if utf8 { String::from_utf8_lossy(raw).into_owned() } else { encoding_rs::EUC_KR.decode(raw).0.into_owned() };
    s.nfc().collect()
}

/// 중앙 목록 바이트를 해석한다(테스트용으로 분리).
pub fn parse_central(cd: &[u8], count: usize) -> Vec<ZEntry> {
    let mut out = vec![];
    let mut p = 0usize;
    for _ in 0..count {
        if p + 46 > cd.len() || u32le(cd, p) != 0x02014b50 {
            break;
        }
        let flags = u16le(cd, p + 8);
        let method = u16le(cd, p + 10);
        let crc = u32le(cd, p + 16);
        let (cs, us, off) = (u32le(cd, p + 20) as u64, u32le(cd, p + 24) as u64, u32le(cd, p + 42) as u64);
        let (nl, el, cl) = (u16le(cd, p + 28) as usize, u16le(cd, p + 30) as usize, u16le(cd, p + 32) as usize);
        if p + 46 + nl > cd.len() {
            break;
        }
        let name = decode_name(&cd[p + 46..p + 46 + nl], flags & 0x800 != 0);
        let mut unsupported = String::new();
        if flags & 1 != 0 {
            unsupported = "지원하지 않는 압축(암호)".into();
        } else if cs == 0xFFFF_FFFF || us == 0xFFFF_FFFF || off == 0xFFFF_FFFF {
            unsupported = "지원하지 않는 압축(zip64)".into();
        } else if method != 0 && method != 8 {
            unsupported = "지원하지 않는 압축 방식".into();
        }
        let base = name.rsplit('/').next().unwrap_or(&name).to_string();
        out.push(ZEntry { name, base, method, crc, csize: cs, usize: us, offset: off, unsupported });
        p += 46 + nl + el + cl;
    }
    out
}

impl Zip {
    fn range(&self, off: u64, len: u64) -> Result<Box<dyn Read>> {
        if let Some(p) = &self.local {
            let mut f = File::open(p)?;
            std::io::Seek::seek(&mut f, std::io::SeekFrom::Start(off))?;
            return Ok(Box::new(f.take(len)));
        }
        let r = get_range(&self.url, &format!("bytes={}-{}", off, off + len - 1))?;
        if r.status().as_u16() != 206 {
            bail!("서버가 구간 요청을 지원하지 않습니다");
        }
        Ok(Box::new(r.into_body().into_reader().take(len)))
    }

    fn read_vec(&self, off: u64, len: u64) -> Result<Vec<u8>> {
        let mut v = Vec::with_capacity(len as usize);
        self.range(off, len)?.read_to_end(&mut v)?;
        Ok(v)
    }

    /// 열기: 끝 64KB 와 중앙 목록만 받는다. Range 가 안 되면 전체를 임시 폴더에 받는다.
    pub fn open(home: &Home, url: &str, prog: source::Progress) -> Result<Zip> {
        let real = resolve(url)?;
        let r = get_range(&real, "bytes=-65536")?;
        let (size, tail, ranged) = if r.status().as_u16() == 206 {
            let total = r.headers().get("content-range").and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit('/').next()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            let mut b = vec![];
            r.into_body().into_reader().take(1 << 20).read_to_end(&mut b)?;
            (total, b, true)
        } else {
            drop(r);
            (0, vec![], false)
        };
        let mut z = Zip { url: real.clone(), local: None, size, entries: vec![], fetched: tail.len() as u64, ranged };
        let mut tail = tail;
        if !ranged {
            // 전체 받기(임시 파일, 진행률·취소)
            source::reset_cancel();
            let dir = home.source_dir(SID).join("_zip");
            fs::create_dir_all(&dir)?;
            let path = dir.join(format!("{}.zip.part", source_key(url)));
            let mut resp = get_range(&real, "bytes=0-")?;
            let total = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            let mut out = File::create(&path)?;
            let mut rd = resp.body_mut().as_reader();
            let (mut buf, mut done) = (vec![0u8; 256 << 10], 0u64);
            loop {
                if source::is_cancelled() {
                    bail!("취소했습니다.");
                }
                let n = rd.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])?;
                done += n as u64;
                prog("압축 파일 받는 중", done, total);
            }
            z.size = done;
            z.fetched = done;
            z.local = Some(path.clone());
            let mut f = File::open(&path)?;
            let from = done.saturating_sub(65536);
            std::io::Seek::seek(&mut f, std::io::SeekFrom::Start(from))?;
            tail.clear();
            f.read_to_end(&mut tail)?;
        }
        // 끝 기록(EOCD)
        let Some(pos) = tail.windows(4).rposition(|w| w == b"PK\x05\x06") else { bail!("zip 파일이 아니거나 끝 기록을 찾을 수 없습니다") };
        if tail.len() < pos + 22 {
            bail!("zip 끝 기록이 잘렸습니다");
        }
        let count = u16le(&tail, pos + 10) as usize;
        let (cd_size, cd_off) = (u32le(&tail, pos + 12) as u64, u32le(&tail, pos + 16) as u64);
        if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_off == 0xFFFF_FFFF {
            bail!("지원하지 않는 압축(zip64)입니다");
        }
        let tail_start = z.size - tail.len() as u64;
        let cd = if cd_off >= tail_start { tail[(cd_off - tail_start) as usize..(cd_off - tail_start + cd_size) as usize].to_vec() } else {
            z.fetched += cd_size;
            z.read_vec(cd_off, cd_size)?
        };
        z.entries = parse_central(&cd, count);
        Ok(z)
    }

    /// 목록에 보여 줄 자료 항목(확장자 .bdb .sdb .dct .cdb)과 설명 파일 내용
    pub fn items(&mut self) -> Result<Vec<LocalItem>> {
        let mut descs = std::collections::HashMap::new();
        if let Some(e) = self.entries.iter().find(|e| e.base == "번역본파일목록.txt" && e.unsupported.is_empty() && e.usize < (1 << 20)).cloned() {
            if let Ok(b) = self.extract_vec(&e) {
                self.fetched += e.csize;
                let t = String::from_utf8_lossy(&b).into_owned();
                for l in t.lines() {
                    if let Some((n, d)) = l.trim().strip_prefix('◆').and_then(|r| r.split_once(':')) {
                        descs.insert(n.trim().nfc().collect::<String>(), d.trim().to_string());
                    }
                }
            }
        }
        let mut out = vec![];
        for e in &self.entries {
            let (stem, ext) = match e.base.rsplit_once('.') {
                Some((s, x)) => (s.to_string(), x.to_lowercase()),
                None => continue,
            };
            let kind = match ext.as_str() {
                "bdb" => "bible",
                "sdb" => "code",
                "dct" => "lex",
                "cdb" => "comm",
                "hdb" | "cmp" => "skip",
                _ => continue,
            };
            let mut it = LocalItem { path: e.name.clone(), id: format!("{kind}:{stem}"), kind: kind.into(), name: stem.clone(), grp: String::new(), bytes: e.csize, rows: 0, desc: descs.get(&stem).cloned().unwrap_or_default(), skip: e.unsupported.clone() };
            if kind == "skip" {
                it.skip = if e.base.to_lowercase().ends_with(".cmp") { "악보 묶음(.cmp)은 아직 지원하지 않습니다".into() } else { "찬송가는 아직 지원하지 않습니다".into() };
            }
            it.grp = match kind {
                "bible" => localfiles::guess_grp(&stem).into(),
                "code" => "원어 번호 본문".into(),
                "lex" => "사전".into(),
                "comm" => "주석".into(),
                _ => String::new(),
            };
            out.push(it);
        }
        Ok(out)
    }

    fn extract_vec(&self, e: &ZEntry) -> Result<Vec<u8>> {
        let mut v = vec![];
        self.extract(e, &mut v)?;
        Ok(v)
    }

    /// 항목 하나의 구간만 받아 풀고 CRC32 를 확인한다.
    pub fn extract(&self, e: &ZEntry, out: &mut dyn Write) -> Result<()> {
        if !e.unsupported.is_empty() {
            bail!("{}: {}", e.base, e.unsupported);
        }
        let h = self.read_vec(e.offset, 30)?;
        if h.len() < 30 || u32le(&h, 0) != 0x04034b50 {
            bail!("{}: 로컬 헤더가 올바르지 않습니다", e.base);
        }
        let start = e.offset + 30 + u16le(&h, 26) as u64 + u16le(&h, 28) as u64;
        let rd = self.range(start, e.csize)?;
        let mut crc = flate2::Crc::new();
        let mut src: Box<dyn Read> = if e.method == 8 { Box::new(flate2::read::DeflateDecoder::new(rd)) } else { rd };
        let (mut buf, mut n) = (vec![0u8; 256 << 10], 0u64);
        loop {
            let k = src.read(&mut buf).map_err(|_| anyhow::anyhow!("{}: 압축을 풀지 못했습니다", e.base))?;
            if k == 0 {
                break;
            }
            crc.update(&buf[..k]);
            out.write_all(&buf[..k])?;
            n += k as u64;
            if source::is_cancelled() {
                bail!("취소했습니다.");
            }
        }
        if crc.sum() != e.crc || n != e.usize {
            bail!("{}: CRC32 가 다릅니다(받은 자료가 깨졌습니다)", e.base);
        }
        Ok(())
    }
}

fn crc_tag(e: &ZEntry) -> String {
    format!("{:08x}-{}", e.crc, e.usize)
}

/// 목록 미리보기(항목 선언 모양의 JSON). 목록을 읽는 데 받은 바이트 수와 전체 크기도 돌려준다.
pub fn preview(home: &Home, url: &str) -> Result<(Vec<serde_json::Value>, u64, u64)> {
    let mut z = Zip::open(home, url, &mut |_, _, _| {})?;
    let items = z.items()?;
    let files = items
        .iter()
        .map(|i| {
            let tag = z.entries.iter().find(|e| e.name == i.path).map(crc_tag).unwrap_or_default();
            serde_json::json!({"id": i.id, "kind": i.kind, "name": i.name, "grp": i.grp, "bytes": i.bytes, "sha256": tag, "license": i.desc, "skip": i.skip, "url": i.path})
        })
        .collect();
    let r = (files, z.fetched, z.size);
    if let Some(p) = &z.local {
        let _ = fs::remove_file(p);
    }
    Ok(r)
}

fn ensure_state(home: &Home) -> source::State {
    source::load_state(home, SID).unwrap_or(source::State {
        decl: source::Declaration { links: vec![], format: source::FORMAT.into(), layout: String::new(), title: String::new(), updated: String::new(), note: String::new(), files: vec![] },
        installed: vec![],
        origin: String::new(),
        sources: vec![],
        hidden: vec![],
        pruned: vec![],
        items: vec![],
    })
}

fn import_entry(home: &Home, z: &Zip, e: &ZEntry, it: &LocalItem, prog: source::Progress) -> Result<()> {
    let dir = home.source_dir(SID).join("_zip");
    fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("x{}.tmp", &hex(&Sha256::digest(it.id.as_bytes()))[..10]));
    let label = format!("{} 받는 중", it.name);
    prog(&label, 0, e.csize);
    let r = (|| -> Result<()> {
        let mut f = File::create(&tmp)?;
        z.extract(e, &mut f)?;
        f.flush()?;
        Ok(())
    })();
    if let Err(x) = r {
        let _ = fs::remove_file(&tmp);
        return Err(x);
    }
    prog(&label, e.csize, e.csize);
    let mut li = it.clone();
    li.path = tmp.to_string_lossy().into();
    let res = (|| -> Result<()> {
        li.rows = localfiles::check(&tmp, &li.kind).map_err(|x| anyhow::anyhow!("{}: {x}", it.name))?;
        localfiles::import_one(home, &li, true, source_key_of(z), "zip", prog)?;
        Ok(())
    })();
    let _ = fs::remove_file(&tmp);
    res
}

fn source_key_of(z: &Zip) -> String {
    source_key(&z.url)
}

/// 고른 항목만 받아 통합 DB에 넣는다. 이미 같은 id 가 다른 출처에 있으면 건너뛴다.
pub fn add(home: &Home, url: &str, ids: &[String], prog: source::Progress) -> Result<source::State> {
    source::reset_cancel();
    let mut z = Zip::open(home, url, prog)?;
    let items = z.items()?;
    let key = source_key(url);
    secret::store(home, &format!("src-{key}"), url)?;
    let mut st = ensure_state(home);
    for id in ids {
        let it = items.iter().find(|i| &i.id == id).ok_or_else(|| anyhow::anyhow!("목록에 없는 항목: {id}"))?;
        let e = z.entries.iter().find(|e| e.name == it.path).cloned().ok_or_else(|| anyhow::anyhow!("목록에 없는 항목: {id}"))?;
        if let Some(r) = st.items.iter().find(|r| &r.id == id) {
            if r.source != key || r.sha256 == crc_tag(&e) {
                continue;
            }
        }
        let before = z.fetched;
        import_entry(home, &z, &e, it, prog)?;
        z.fetched = before + e.csize;
        st = ensure_state(home);
        if let Some(r) = st.items.iter_mut().find(|r| &r.id == id) {
            r.sha256 = crc_tag(&e);
            r.source = key.clone();
            r.bytes = e.csize;
        }
        if !st.sources.iter().any(|s| s.key == key) {
            st.sources.push(SrcInfo { kind: "zip".into(), key: key.clone(), origin: "압축 파일".into(), title: "압축 파일".into(), files: vec![] });
        }
        let si = st.sources.iter_mut().find(|s| s.key == key).unwrap();
        push_unique(&mut si.files, id);
        save_state(home, &st)?;
    }
    if let Some(p) = &z.local {
        let _ = fs::remove_file(p);
    }
    Ok(st)
}

/// 갱신: zip 크기·중앙 목록의 CRC 가 바뀐 항목만 다시 받는다.
pub fn sync(home: &Home, url: &str, st: &mut source::State, prog: source::Progress) -> Result<Vec<String>> {
    let key = source_key(url);
    let mut z = Zip::open(home, url, prog)?;
    let items = z.items()?;
    let mut up = vec![];
    for rec in st.items.clone().into_iter().filter(|r| r.source == key) {
        let Some(it) = items.iter().find(|i| i.id == rec.id) else { continue };
        let Some(e) = z.entries.iter().find(|e| e.name == it.path).cloned() else { continue };
        if crc_tag(&e) != rec.sha256 {
            import_entry(home, &z, &e, it, prog)?;
            let mut s2 = ensure_state(home);
            if let Some(r) = s2.items.iter_mut().find(|r| r.id == rec.id) {
                r.sha256 = crc_tag(&e);
                r.source = key.clone();
            }
            save_state(home, &s2)?;
            *st = s2;
            up.push(rec.id.clone());
        }
    }
    Ok(up)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drive_links() {
        for u in [
            "https://drive.google.com/file/d/1AbC_-9/view?usp=sharing",
            "https://drive.google.com/open?id=1AbC_-9",
            "https://drive.google.com/uc?export=download&id=1AbC_-9",
            "https://drive.usercontent.google.com/download?id=1AbC_-9&export=download",
        ] {
            assert_eq!(drive_id(u).as_deref(), Some("1AbC_-9"), "{u}");
            assert!(looks_zip(u));
        }
        assert!(drive_url("X").contains("drive.usercontent.google.com/download?id=X"));
        assert!(drive_id("https://example.com/a.zip").is_none() && looks_zip("https://example.com/a.zip?x=1"));
    }
    #[test]
    fn confirm_form() {
        let html = r#"<form action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="X"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>"#;
        let u = parse_confirm(html, "X").unwrap();
        assert!(u.contains("confirm=t") && u.contains("uuid=u-1"));
        assert!(parse_confirm("<html>권한 없음 / 할당량 초과</html>", "X").is_none());
    }
    #[test]
    fn name_decoding() {
        // CP949 로 된 "개역개정.bdb"
        let (raw, _, _) = encoding_rs::EUC_KR.encode("개역개정.bdb");
        assert_eq!(decode_name(&raw, false), "개역개정.bdb");
        assert_eq!(decode_name("개역개정.bdb".as_bytes(), true), "개역개정.bdb");
    }
}
