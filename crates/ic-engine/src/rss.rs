//! Peak resident set size for `IndexStats::peak_rss_bytes`.

/// Current peak RSS in bytes. Zero when the platform cannot report one.
///
/// Linux reads `VmHWM` from `/proc/self/status` (kB). Elsewhere this uses
/// `getrusage(RUSAGE_SELF).ru_maxrss`, which is bytes on macOS and kilobytes
/// on most other Unix platforms.
#[must_use]
pub fn peak_rss_bytes() -> u64 {
    #[cfg(target_os = "linux")]
    {
        peak_rss_linux()
    }
    #[cfg(not(target_os = "linux"))]
    {
        peak_rss_rusage()
    }
}

#[cfg(target_os = "linux")]
fn peak_rss_linux() -> u64 {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return 0;
    };
    for line in status.lines() {
        let Some(rest) = line.strip_prefix("VmHWM:") else {
            continue;
        };
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(kb) = digits.parse::<u64>() {
            return kb.saturating_mul(1024);
        }
    }
    0
}

#[cfg(not(target_os = "linux"))]
fn peak_rss_rusage() -> u64 {
    // SAFETY: getrusage with RUSAGE_SELF and a stack-allocated rusage is safe.
    unsafe {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        if libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) != 0 {
            return 0;
        }
        let usage = usage.assume_init();
        let rss = usage.ru_maxrss;
        if rss <= 0 {
            return 0;
        }
        let rss = rss.cast_unsigned();
        // macOS and the BSDs report bytes; Linux would report kB but uses VmHWM above.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            rss
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            rss.saturating_mul(1024)
        }
    }
}
