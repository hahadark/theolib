//! 현지 시각 문자열 "YYYY-MM-DD HH:MM:SS" (새 의존성 없이 OS 호출 직접 선언).
//! 날짜 계산(윤년, 경과 초, 어제 등)은 순수 함수로 분리해 시험한다.

/// 윤년인지(그레고리력).
pub fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// 1~12월의 날 수.
pub fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// `y-m-d`(1월 1일부터의 일 수). 1970-01-01 = 0.
pub fn day_number(y: i64, m: i64, d: i64) -> i64 {
    let mut n = 0i64;
    for yy in 1970..y {
        n += if is_leap(yy) { 366 } else { 365 };
    }
    for mm in 1..m {
        n += days_in_month(y, mm);
    }
    n + (d - 1)
}

/// `day_number`의 역. (y, m, d) 를 돌려준다.
pub fn from_day_number(n: i64) -> (i64, i64, i64) {
    let mut y = 1970i64;
    let mut rem = n;
    loop {
        let len = if is_leap(y) { 366 } else { 365 };
        if rem < len {
            break;
        }
        rem -= len;
        y += 1;
    }
    let mut m = 1i64;
    loop {
        let len = days_in_month(y, m);
        if rem < len {
            break;
        }
        rem -= len;
        m += 1;
    }
    (y, m, rem + 1)
}

#[cfg(windows)]
mod sys {
    #[repr(C)]
    struct SystemTime {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLocalTime(lp: *mut SystemTime);
    }
    /// (년, 월, 일, 시, 분, 초)
    pub fn local() -> (i64, i64, i64, i64, i64, i64) {
        let mut st = SystemTime {
            w_year: 0,
            w_month: 0,
            w_day_of_week: 0,
            w_day: 0,
            w_hour: 0,
            w_minute: 0,
            w_second: 0,
            w_milliseconds: 0,
        };
        unsafe { GetLocalTime(&mut st) };
        (
            st.w_year as i64,
            st.w_month as i64,
            st.w_day as i64,
            st.w_hour as i64,
            st.w_minute as i64,
            st.w_second as i64,
        )
    }
}

#[cfg(not(windows))]
mod sys {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct Tm {
        tm_sec: i32,
        tm_min: i32,
        tm_hour: i32,
        tm_mday: i32,
        tm_mon: i32,
        tm_year: i32,
        tm_wday: i32,
        tm_yday: i32,
        tm_isdst: i32,
        #[allow(dead_code)]
        tm_gmtoff: i64,
        #[allow(dead_code)]
        tm_zone: *const i8,
    }
    unsafe extern "C" {
        fn time(t: *mut i64) -> i64;
        fn localtime_r(t: *const i64, tm: *mut Tm) -> *mut Tm;
    }
    /// (년, 월, 일, 시, 분, 초)
    pub fn local() -> (i64, i64, i64, i64, i64, i64) {
        let mut t: i64 = 0;
        unsafe { time(&mut t) };
        let mut tm = Tm {
            tm_sec: 0,
            tm_min: 0,
            tm_hour: 0,
            tm_mday: 0,
            tm_mon: 0,
            tm_year: 0,
            tm_wday: 0,
            tm_yday: 0,
            tm_isdst: 0,
            tm_gmtoff: 0,
            tm_zone: std::ptr::null(),
        };
        unsafe {
            localtime_r(&t, &mut tm);
        }
        (
            tm.tm_year as i64 + 1900,
            tm.tm_mon as i64 + 1,
            tm.tm_mday as i64,
            tm.tm_hour as i64,
            tm.tm_min as i64,
            tm.tm_sec as i64,
        )
    }
}

/// 지금 현지 시각 "YYYY-MM-DD HH:MM:SS".
pub fn now() -> String {
    let (y, mo, d, h, mi, s) = sys::local();
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

/// 지금 현지 시각의 "HH:MM:SS"(단계 기록용).
pub fn now_time() -> String {
    let (_, _, _, h, mi, s) = sys::local();
    format!("{h:02}:{mi:02}:{s:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leap_years() {
        assert!(is_leap(2000));
        assert!(is_leap(2024));
        assert!(!is_leap(1900));
        assert!(!is_leap(2023));
    }

    #[test]
    fn day_number_roundtrip() {
        assert_eq!(day_number(1970, 1, 1), 0);
        assert_eq!(day_number(1970, 1, 31), 30);
        assert_eq!(day_number(1970, 2, 1), 31);
        assert_eq!(day_number(1971, 1, 1), 365);
        // 2024 윤년 2월
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(day_number(2024, 2, 29), day_number(2024, 3, 1) - 1);
        for n in [0, 30, 31, 365, 366, 700, 20000] {
            let (y, m, d) = from_day_number(n);
            assert_eq!(day_number(y, m, d), n);
        }
    }

    #[test]
    fn now_format() {
        let s = now();
        assert_eq!(s.len(), 19, "{s}");
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[7], b'-');
        assert_eq!(s.as_bytes()[10], b' ');
        assert_eq!(s.as_bytes()[13], b':');
        assert_eq!(s.as_bytes()[16], b':');
        let t = now_time();
        assert_eq!(t.len(), 8);
    }
}
