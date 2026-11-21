//! 서버가 만든 HTML을 스크립트 없이 안전하게 보이도록 허용 목록으로 걸러낸다.
//! 허용: 서식 태그, class, `data-c`(원어 번호), 색상만 있는 style. 나머지는 제거.

const ALLOWED: &[&str] = &[
    "a", "b", "i", "u", "em", "strong", "br", "p", "div", "span", "sup", "sub", "small", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "td", "th", "hr", "ruby", "rt", "font",
];
const DROP_WITH_CONTENT: &[&str] = &["script", "style", "iframe", "object", "embed", "template", "noscript"];

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn safe_class(v: &str) -> bool {
    v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ')
}
fn safe_code(v: &str) -> bool {
    v.len() < 12 && v.chars().all(|c| c.is_ascii_alphanumeric())
}
fn safe_style(v: &str) -> Option<String> {
    // color:#rrggbb 선언만 남긴다
    v.split(';').find_map(|d| {
        let t = d.replace(' ', "").to_lowercase();
        let c = t.strip_prefix("color:#")?;
        (matches!(c.len(), 3 | 6) && c.chars().all(|x| x.is_ascii_hexdigit())).then(|| format!("color:#{c}"))
    })
}

/// 속성 문자열에서 (이름, 값) 목록. 따옴표 있는/없는 값 모두 처리.
fn attrs(s: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_whitespace() || b[i] == '/') {
            i += 1;
        }
        let st = i;
        while i < b.len() && !b[i].is_whitespace() && b[i] != '=' && b[i] != '/' {
            i += 1;
        }
        let name: String = b[st..i].iter().collect::<String>().to_lowercase();
        if name.is_empty() {
            break;
        }
        let mut val = String::new();
        if i < b.len() && b[i] == '=' {
            i += 1;
            if i < b.len() && (b[i] == '"' || b[i] == '\'') {
                let q = b[i];
                i += 1;
                let s2 = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                val = b[s2..i].iter().collect();
                i += 1;
            } else {
                let s2 = i;
                while i < b.len() && !b[i].is_whitespace() {
                    i += 1;
                }
                val = b[s2..i].iter().collect();
            }
        }
        out.push((name, val));
    }
    out
}

pub fn sanitize(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i].replace('>', "&gt;"));
        let after = &rest[i + 1..];
        // 주석
        if let Some(a) = after.strip_prefix("!--") {
            rest = a.find("-->").map(|e| &a[e + 3..]).unwrap_or("");
            continue;
        }
        let Some(end) = after.find('>') else {
            out.push_str("&lt;");
            rest = after;
            continue;
        };
        let inner = &after[..end];
        rest = &after[end + 1..];
        let closing = inner.starts_with('/');
        let body = inner.trim_start_matches('/');
        let name_end = body.find(|c: char| c.is_whitespace() || c == '/').unwrap_or(body.len());
        let name = body[..name_end].to_lowercase();
        if !closing && DROP_WITH_CONTENT.contains(&name.as_str()) {
            let close = format!("</{name}");
            let low = rest.to_lowercase();
            rest = match low.find(&close) {
                Some(p) => rest[p..].find('>').map(|e| &rest[p + e + 1..]).unwrap_or(""),
                None => "",
            };
            continue;
        }
        if !ALLOWED.contains(&name.as_str()) {
            continue;
        }
        if closing {
            if name != "br" && name != "hr" {
                out.push_str(&format!("</{name}>"));
            }
            continue;
        }
        let mut tag = format!("<{name}");
        for (k, v) in attrs(&body[name_end..]) {
            match k.as_str() {
                "class" if safe_class(&v) => tag.push_str(&format!(" class=\"{v}\"")),
                "color" if name == "font" && v.starts_with('#') && matches!(v.len(), 4 | 7) && v[1..].chars().all(|x| x.is_ascii_hexdigit()) => tag.push_str(&format!(" color=\"{}\"", v.to_lowercase())),
                "data-c" if safe_code(&v) => tag.push_str(&format!(" data-c=\"{v}\"")),
                "style" => {
                    if let Some(s) = safe_style(&v) {
                        tag.push_str(&format!(" style=\"{s}\""));
                    }
                }
                "colspan" | "rowspan" if v.chars().all(|c| c.is_ascii_digit()) && !v.is_empty() => tag.push_str(&format!(" {k}=\"{v}\"")),
                _ => {}
            }
        }
        tag.push('>');
        out.push_str(&tag);
    }
    out.push_str(&rest.replace('>', "&gt;"));
    out
}

/// 일반 텍스트(fmt=text): 줄바꿈만 살린다.
pub fn text_to_html(t: &str) -> String {
    esc(t).replace("\r\n", "\n").replace('\n', "<br>")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_dangerous() {
        let s = sanitize(r#"안녕<script>alert(1)</script><a href="javascript:x" onclick="x()" class="sc" data-c="G611">G611</a><img src=x onerror=y><b style="color:#328AE1;background:url(x)">굵게</b><span style="background:red">z</span>"#);
        assert!(!s.contains("script") && !s.contains("onclick") && !s.contains("href") && !s.contains("<img") && !s.contains("url("));
        assert!(s.contains("data-c=\"G611\"") && s.contains("color:#328ae1") && s.contains("굵게"));
    }
    #[test]
    fn text_keeps_newlines() {
        assert_eq!(text_to_html("a<b\nc"), "a&lt;b<br>c");
    }
}
