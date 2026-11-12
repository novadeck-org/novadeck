//! How a raw Windows command line splits after its program's name: what `novadeck-cmd` and
//! `novadeck-pwsh` pass on to the real program, untouched, as `GetCommandLineW` gives it.

/// What follows the program name in a raw Windows command line, as the C runtime reads
/// argv[0]: a name in quotes ends at the next quote (no escapes), any other at the first
/// space or tab. The blanks after the name are dropped; the rest is kept as it is.
pub fn after_program(line: &[u16]) -> &[u16] {
    let quote = u16::from(b'"');
    let blank = |unit: &u16| *unit == u16::from(b' ') || *unit == u16::from(b'\t');
    let name_end = if line.first() == Some(&quote) {
        line[1..]
            .iter()
            .position(|unit| *unit == quote)
            .map_or(line.len(), |at| at + 2)
    } else {
        line.iter().position(blank).unwrap_or(line.len())
    };
    let rest = &line[name_end..];
    &rest[rest.iter().take_while(|unit| blank(unit)).count()..]
}

#[cfg(test)]
mod tests {
    use super::after_program;

    fn rest(line: &str) -> String {
        let wide: Vec<u16> = line.encode_utf16().collect();
        String::from_utf16(after_program(&wide)).unwrap()
    }

    #[test]
    fn an_unquoted_name_ends_at_the_first_blank() {
        assert_eq!(rest(r#"cmd /c "echo hi""#), r#"/c "echo hi""#);
        assert_eq!(rest("cmd\t/c x"), "/c x");
    }

    #[test]
    fn a_quoted_name_may_hold_spaces() {
        assert_eq!(
            rest(r#""C:\Program Files\x\cmd.exe" /c "a  b""#),
            r#"/c "a  b""#
        );
    }

    #[test]
    fn a_quoted_name_is_not_split_by_quotes_in_the_rest() {
        assert_eq!(rest(r#""cmd" /c "x" "y""#), r#"/c "x" "y""#);
    }

    #[test]
    fn the_rest_keeps_its_inner_blanks_and_trailing_ones() {
        assert_eq!(rest("cmd   /c  a  b  "), "/c  a  b  ");
    }

    #[test]
    fn a_name_alone_leaves_an_empty_rest() {
        assert_eq!(rest("cmd"), "");
        assert_eq!(rest(r#""C:\a b\cmd.exe""#), "");
        assert_eq!(rest(r#""C:\a b\cmd.exe"  "#), "");
        assert_eq!(rest(""), "");
    }

    #[test]
    fn an_unclosed_quote_takes_the_whole_line_as_the_name() {
        assert_eq!(rest(r#""cmd /c x"#), "");
    }
}
