//! 66권 상수 표(실제 DB에는 book 표가 없다). 번호 1=창세기 … 66=요한계시록.
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Book {
    pub n: i64,
    pub name: String,
    pub abbr: String,
    pub en: String,
    pub ch: i64,
    pub alias: Vec<String>,
}

/// (한글 이름, 한글 약어, 영문 이름, 영문 약칭, 장 수)
const T: [(&str, &str, &str, &str, i64); 66] = [
    ("창세기", "창", "Genesis", "gen", 50),
    ("출애굽기", "출", "Exodus", "exo", 40),
    ("레위기", "레", "Leviticus", "lev", 27),
    ("민수기", "민", "Numbers", "num", 36),
    ("신명기", "신", "Deuteronomy", "deu", 34),
    ("여호수아", "수", "Joshua", "jos", 24),
    ("사사기", "삿", "Judges", "jdg", 21),
    ("룻기", "룻", "Ruth", "rut", 4),
    ("사무엘상", "삼상", "1 Samuel", "1sa", 31),
    ("사무엘하", "삼하", "2 Samuel", "2sa", 24),
    ("열왕기상", "왕상", "1 Kings", "1ki", 22),
    ("열왕기하", "왕하", "2 Kings", "2ki", 25),
    ("역대상", "대상", "1 Chronicles", "1ch", 29),
    ("역대하", "대하", "2 Chronicles", "2ch", 36),
    ("에스라", "스", "Ezra", "ezr", 10),
    ("느헤미야", "느", "Nehemiah", "neh", 13),
    ("에스더", "에", "Esther", "est", 10),
    ("욥기", "욥", "Job", "job", 42),
    ("시편", "시", "Psalms", "psa", 150),
    ("잠언", "잠", "Proverbs", "pro", 31),
    ("전도서", "전", "Ecclesiastes", "ecc", 12),
    ("아가", "아", "Song of Solomon", "sng", 8),
    ("이사야", "사", "Isaiah", "isa", 66),
    ("예레미야", "렘", "Jeremiah", "jer", 52),
    ("예레미야애가", "애", "Lamentations", "lam", 5),
    ("에스겔", "겔", "Ezekiel", "eze", 48),
    ("다니엘", "단", "Daniel", "dan", 12),
    ("호세아", "호", "Hosea", "hos", 14),
    ("요엘", "욜", "Joel", "joe", 3),
    ("아모스", "암", "Amos", "amo", 9),
    ("오바댜", "옵", "Obadiah", "oba", 1),
    ("요나", "욘", "Jonah", "jon", 4),
    ("미가", "미", "Micah", "mic", 7),
    ("나훔", "나", "Nahum", "nah", 3),
    ("하박국", "합", "Habakkuk", "hab", 3),
    ("스바냐", "습", "Zephaniah", "zep", 3),
    ("학개", "학", "Haggai", "hag", 2),
    ("스가랴", "슥", "Zechariah", "zec", 14),
    ("말라기", "말", "Malachi", "mal", 4),
    ("마태복음", "마", "Matthew", "mat", 28),
    ("마가복음", "막", "Mark", "mar", 16),
    ("누가복음", "눅", "Luke", "luk", 24),
    ("요한복음", "요", "John", "joh", 21),
    ("사도행전", "행", "Acts", "act", 28),
    ("로마서", "롬", "Romans", "rom", 16),
    ("고린도전서", "고전", "1 Corinthians", "1co", 16),
    ("고린도후서", "고후", "2 Corinthians", "2co", 13),
    ("갈라디아서", "갈", "Galatians", "gal", 6),
    ("에베소서", "엡", "Ephesians", "eph", 6),
    ("빌립보서", "빌", "Philippians", "php", 4),
    ("골로새서", "골", "Colossians", "col", 4),
    ("데살로니가전서", "살전", "1 Thessalonians", "1th", 5),
    ("데살로니가후서", "살후", "2 Thessalonians", "2th", 3),
    ("디모데전서", "딤전", "1 Timothy", "1ti", 6),
    ("디모데후서", "딤후", "2 Timothy", "2ti", 4),
    ("디도서", "딛", "Titus", "tit", 3),
    ("빌레몬서", "몬", "Philemon", "phm", 1),
    ("히브리서", "히", "Hebrews", "heb", 13),
    ("야고보서", "약", "James", "jam", 5),
    ("베드로전서", "벧전", "1 Peter", "1pe", 5),
    ("베드로후서", "벧후", "2 Peter", "2pe", 3),
    ("요한일서", "요일", "1 John", "1jo", 5),
    ("요한이서", "요이", "2 John", "2jo", 1),
    ("요한삼서", "요삼", "3 John", "3jo", 1),
    ("유다서", "유", "Jude", "jud", 1),
    ("요한계시록", "계", "Revelation", "rev", 22),
];

pub fn books() -> Vec<Book> {
    T.iter()
        .enumerate()
        .map(|(i, t)| Book { n: i as i64 + 1, name: t.0.into(), abbr: t.1.into(), en: t.2.into(), ch: t.4, alias: vec![t.3.into(), t.2.replace(' ', "").to_lowercase()] })
        .collect()
}

fn keys(b: &Book) -> Vec<String> {
    let mut k = vec![b.name.to_lowercase(), b.abbr.to_lowercase(), b.en.to_lowercase()];
    k.extend(b.alias.iter().map(|a| a.to_lowercase()));
    k
}

pub fn resolve_book(s: &str) -> Option<i64> {
    let t = s.trim().trim_end_matches('.').to_lowercase();
    let bs = books();
    if let Ok(n) = t.parse::<i64>() {
        if (1..=66).contains(&n) {
            return Some(n);
        }
    }
    bs.iter().find(|b| keys(b).iter().any(|k| *k == t)).map(|b| b.n)
}

/// "행 24:10", "사도행전 24", "Acts 24:10-12", "행24:10" → (책, 장, 절?)
pub fn parse_ref(input: &str) -> Option<(i64, i64, Option<i64>)> {
    let low = input.trim().to_lowercase();
    let mut best: Option<(usize, i64)> = None;
    for b in books() {
        for k in keys(&b) {
            if k.is_empty() || !low.starts_with(&k) {
                continue;
            }
            let rest = low[k.len()..].trim_start_matches(['.', ' ']);
            if rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && best.map(|(l, _)| k.len() > l).unwrap_or(true) {
                best = Some((k.len(), b.n));
            }
        }
    }
    let (len, bk) = best?;
    let rest = low[len..].trim_start_matches(['.', ' ']);
    let (chs, vs) = match rest.split_once([':', '.']) {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    let ch: i64 = chs.trim().trim_end_matches('장').parse().ok()?;
    let v = vs.and_then(|x| {
        let d: String = x.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
        d.parse().ok()
    });
    Some((bk, ch, v))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refs() {
        assert_eq!(parse_ref("행 24:10"), Some((44, 24, Some(10))));
        assert_eq!(parse_ref("사도행전 24"), Some((44, 24, None)));
        assert_eq!(parse_ref("Acts 24:10-12"), Some((44, 24, Some(10))));
        assert_eq!(parse_ref("요일 1:9"), Some((62, 1, Some(9))));
        assert_eq!(parse_ref("1 John 1:9"), Some((62, 1, Some(9))));
        assert_eq!(parse_ref("사랑"), None);
        assert_eq!(books().len(), 66);
        assert_eq!(books()[43].name, "사도행전");
    }
}
