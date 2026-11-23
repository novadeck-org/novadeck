//! Whether a folder a shim gives an agent beside its own goes after it. Antigravity orders its
//! workspaces, its own folder and those added with `--add-dir`, by path, byte for byte and case
//! and all, and tells the model the first is the working directory its commands run in, so an
//! added folder that sorts first takes the session's place (probed 2026-11-23, 1.5.13,
//! `e2e/probes/agy-worktrees-folder.e2e.ts`). cmd has no comparison of its own that orders bytes,
//! so Antigravity's Windows shim asks the relay (`harnesses/core/src/shim-root.ts`).

/// Whether `folder` sorts after `cwd`, byte for byte, as Antigravity sorts them, and is neither
/// `cwd` nor a folder above it, which always sorts first (a case of its own, where `ignore_case`,
/// as on Windows, whose paths name the same folder in any case).
pub fn sorts_after(folder: &str, cwd: &str, ignore_case: bool) -> bool {
    let folder = trimmed(folder);
    let cwd = trimmed(cwd);
    if folder.is_empty() || cwd.is_empty() || holds(folder, cwd, ignore_case) {
        return false;
    }
    folder.as_bytes() > cwd.as_bytes()
}

/// `path` without the separators it ends in, but for a root's own.
fn trimmed(path: &str) -> &str {
    let cut = path.trim_end_matches(['/', '\\']);
    if cut.is_empty() || cut.ends_with(':') {
        path
    } else {
        cut
    }
}

/// Whether `folder` is `path` or a folder above it.
fn holds(folder: &str, path: &str, ignore_case: bool) -> bool {
    let (folder, path) = if ignore_case {
        (folder.to_lowercase(), path.to_lowercase())
    } else {
        (folder.to_owned(), path.to_owned())
    };
    if folder == path {
        return true;
    }
    let base = folder.trim_end_matches(['/', '\\']);
    path.strip_prefix(base)
        .is_some_and(|rest| rest.starts_with(['/', '\\']))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = r"C:\Users\x\.novadeck\worktrees";

    #[test]
    fn a_folder_sorting_after_the_agents_goes_after_it() {
        assert!(sorts_after(ROOT, r"C:\Users\x\-work", true));
        assert!(sorts_after(ROOT, r"C:\Users\x\+app", true));
        assert!(sorts_after(
            "/home/x/.novadeck/worktrees",
            "/home/x/+app",
            false
        ));
    }

    // As a project in the home, or on another drive, mostly does.
    #[test]
    fn a_folder_sorting_first_does_not() {
        assert!(!sorts_after(ROOT, r"C:\Users\x\Projects\app", true));
        assert!(!sorts_after(ROOT, r"D:\app", true));
        assert!(!sorts_after(
            "/home/x/.novadeck/worktrees",
            "/home/x/projects/app",
            false
        ));
    }

    // Bytes, not a locale's order, nor without case: upper case sorts before lower.
    #[test]
    fn orders_bytes_case_and_all() {
        assert!(sorts_after(r"C:\b", r"C:\Bc", true));
        assert!(!sorts_after(r"C:\B", r"C:\a", true));
        assert!(sorts_after(r"c:\app", r"C:\app2", true));
    }

    // A folder sorts before what it holds, so the agent would work in it.
    #[test]
    fn never_the_folder_itself_nor_from_inside_it() {
        for inside in [
            ROOT,
            r"C:\Users\x\.novadeck\worktrees\",
            r"C:\Users\x\.novadeck\worktrees\app\fix",
            r"C:\USERS\X\.NOVADECK\WORKTREES\app\fix",
            r"c:\users\x\.novadeck\worktrees",
        ] {
            assert!(!sorts_after(ROOT, inside, true), "{inside}");
        }
        assert!(!sorts_after("/w", "/w/app", false));
        // A sibling whose name begins with the folder's is outside it.
        assert!(!holds(ROOT, r"C:\Users\x\.novadeck\worktrees2", true));
        // On POSIX case names another folder.
        assert!(!holds("/home/x/w", "/home/x/W/app", false));
    }

    #[test]
    fn nothing_sorts_after_an_empty_path() {
        assert!(!sorts_after("", r"C:\app", true));
        assert!(!sorts_after(ROOT, "", true));
    }
}
