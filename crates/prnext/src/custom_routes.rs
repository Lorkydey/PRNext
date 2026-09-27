//! Build-compiled Next custom routes. Matching work and all expanded output are bounded.
use anyhow::{bail, Context, Result};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Uri};
use fancy_regex::{Regex, RegexBuilder};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};

pub const MAX_URL: usize = 16 * 1024;
const MAX_VALUE: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize)]
pub struct CustomRoutes {
    pub version: u32,
    pub headers: Vec<Rule>,
    pub redirects: Vec<Rule>,
    pub rewrites: Rewrites,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rewrites {
    pub before_files: Vec<Rule>,
    pub after_files: Vec<Rule>,
    pub fallback: Vec<Rule>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub source: String,
    pub regex: String,
    pub keys: Vec<Key>,
    pub has: Vec<Condition>,
    pub missing: Vec<Condition>,
    #[serde(default)]
    pub headers: Vec<CustomHeader>,
    pub destination: Option<Destination>,
    pub status_code: Option<u16>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Key {
    name: Option<String>,
    repeat: bool,
    separator: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Condition {
    #[serde(rename = "type")]
    kind: String,
    key: Option<String>,
    regex: Option<String>,
    captures: Vec<Capture>,
    capture: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
struct Capture {
    name: String,
    index: usize,
}
#[derive(Clone, Debug, Deserialize)]
pub struct CustomHeader {
    key: Template,
    value: Template,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Token {
    Text(String),
    Param {
        param: String,
        prefix: String,
        suffix: String,
        modifier: String,
        #[serde(default)]
        join: Option<String>,
    },
}
pub type Template = Vec<Token>;
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    external: bool,
    protocol: Option<String>,
    hostname: Option<Template>,
    port: Option<String>,
    pathname: Template,
    query: Vec<Query>,
    hash: Template,
    append_params_to_query: bool,
}
#[derive(Clone, Debug, Deserialize)]
struct Query {
    key: String,
    value: Template,
}
#[derive(Default)]
pub struct CompiledRoutes {
    pub headers: Vec<CompiledRule>,
    pub redirects: Vec<CompiledRule>,
    pub before: Vec<CompiledRule>,
    pub after: Vec<CompiledRule>,
    pub fallback: Vec<CompiledRule>,
}
pub struct CompiledRule {
    rule: Rule,
    regex: Regex,
    has: Vec<Option<Regex>>,
    missing: Vec<Option<Regex>>,
}
#[derive(Debug)]
pub struct Param {
    values: Vec<String>,
    raw_path: bool,
}
pub type Captured = BTreeMap<String, Param>;
#[derive(Debug)]
pub struct Target {
    pub url: String,
    pub external: bool,
}

// path-to-regexp emits ECMAScript regexes without the `u` flag. Rust's default
// \d/\w/\b are Unicode-aware; translating them explicitly preserves JS matching
// while Unicode literals and captures continue to use valid UTF-8 strings.
fn js_regex(pattern: &str, insensitive: bool) -> Result<String> {
    const WORD: &str = "(?-i:[A-Za-z0-9_])";
    const SPACE: &str = r"\t\n\x0b\x0c\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";
    fn escape(kind: char, in_class: bool) -> Result<String> {
        Ok(match kind {
            'd' => "[0-9]".into(),
            'D' => "[^0-9]".into(),
            'w' => "[A-Za-z0-9_]".into(),
            'W' => "[^A-Za-z0-9_]".into(),
            's' => format!("[{SPACE}]"),
            'S' => format!("[^{SPACE}]"),
            'b' if in_class => r"\x08".into(),
            'B' if in_class => "B".into(),
            'b' => format!("(?:(?<={WORD})(?!{WORD})|(?<!{WORD})(?={WORD}))"),
            'B' => format!("(?:(?<={WORD})(?={WORD})|(?<!{WORD})(?!{WORD}))"),
            'p' | 'P' | 'a' | 'A' | 'z' | 'Z' | 'G' | 'K' | 'h' | 'H' | 'R' | 'N' | 'e' | 'c' => {
                bail!("unsupported ECMAScript escape \\{kind} in custom route")
            }
            value
                if value.is_ascii_alphabetic()
                    && !matches!(value, 'n' | 'r' | 't' | 'v' | 'f' | 'x' | 'u' | 'k') =>
            {
                bail!("unsupported ECMAScript escape \\{kind} in custom route")
            }
            value => format!("\\{value}"),
        })
    }
    let mut chars = pattern.chars().peekable();
    let mut output = String::new();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                let kind = chars.next().context("trailing regex escape")?;
                if matches!(kind, 'x' | 'u') {
                    let literal = hex_literal(kind, &mut chars)?;
                    if insensitive && matches!(literal, 'k' | 'K') {
                        output.push_str("(?-i:[Kk])");
                    } else if insensitive && matches!(literal, 's' | 'S') {
                        output.push_str("(?-i:[Ss])");
                    } else if insensitive && matches!(literal, 'ſ' | 'K') {
                        output.push_str(&format!("(?-i:{literal})"));
                    } else {
                        output.push_str(&fancy_regex::escape(&literal.to_string()));
                    }
                    continue;
                }
                let translated = escape(kind, false)?;
                if matches!(kind, 'w' | 'W') {
                    output.push_str(&format!("(?-i:{translated})"));
                } else {
                    output.push_str(&translated);
                }
                if kind == 'k' && chars.peek() == Some(&'<') {
                    for name in chars.by_ref() {
                        output.push(name);
                        if name == '>' {
                            break;
                        }
                    }
                }
            }
            '(' if chars.peek() == Some(&'?') => {
                output.push('(');
                output.push(chars.next().unwrap());
                if chars.peek() == Some(&'<') {
                    output.push(chars.next().unwrap());
                    if !matches!(chars.peek(), Some('=' | '!')) {
                        for name in chars.by_ref() {
                            output.push(name);
                            if name == '>' {
                                break;
                            }
                        }
                    }
                }
            }
            '[' => {
                let negative = chars.peek() == Some(&'^');
                if negative {
                    chars.next();
                }
                let mut content = String::new();
                let mut closed = false;
                for_next_class(&mut chars, &mut content, &mut closed, escape)?;
                if !closed {
                    bail!("unterminated custom route character class");
                }
                if content.is_empty() {
                    output.push_str(if negative { "(?s:.)" } else { "(?!)" });
                    continue;
                }
                // Unicode fold tables also fold ASCII S/K to long-s/Kelvin. JS
                // non-u classes do not. Compute the ASCII fold closure explicitly.
                if insensitive {
                    if !content.is_ascii() || content.contains(r"\u") {
                        bail!("case-insensitive Unicode character classes are unsupported; use Unicode literals or a condition without the i flag");
                    }
                    let positive = format!("^[{content}]$");
                    let matcher = RegexBuilder::new(&positive)
                        .backtrack_limit(10_000)
                        .build()?;
                    let mut closure = String::new();
                    for lower in b'a'..=b'z' {
                        let upper = lower.to_ascii_uppercase();
                        if matcher.is_match(&(lower as char).to_string())?
                            || matcher.is_match(&(upper as char).to_string())?
                        {
                            closure.push(lower as char);
                            closure.push(upper as char);
                        }
                    }
                    output.push_str(&format!(
                        "(?-i:[{}{content}{closure}])",
                        if negative { "^" } else { "" }
                    ));
                } else {
                    output.push_str(&format!("[{}{content}]", if negative { "^" } else { "" }));
                }
            }
            // The only non-ASCII characters that fold to ASCII in Unicode's
            // simple folding must not participate in JS's non-u ASCII matching.
            'ſ' | 'K' if insensitive => output.push_str(&format!("(?-i:{ch})")),
            'k' | 'K' if insensitive => output.push_str("(?-i:[Kk])"),
            's' | 'S' if insensitive => output.push_str("(?-i:[Ss])"),
            value => output.push(value),
        }
        if output.len() > 64 * 1024 {
            bail!("translated custom route regex exceeds bounds");
        }
    }
    Ok(output)
}
fn hex_literal<I: Iterator<Item = char>>(kind: char, chars: &mut I) -> Result<char> {
    let mut code = 0u32;
    for _ in 0..if kind == 'x' { 2 } else { 4 } {
        let digit = chars
            .next()
            .and_then(|ch| ch.to_digit(16))
            .context("unsupported ECMAScript hex/Unicode escape")?;
        code = code * 16 + digit;
    }
    char::from_u32(code).context("UTF-16 surrogate regex escapes are unsupported")
}
fn for_next_class<I: Iterator<Item = char>>(
    chars: &mut std::iter::Peekable<I>,
    content: &mut String,
    closed: &mut bool,
    escape: fn(char, bool) -> Result<String>,
) -> Result<()> {
    while let Some(ch) = chars.next() {
        match ch {
            ']' => {
                *closed = true;
                break;
            }
            '\\' => {
                let kind = chars.next().context("trailing character class escape")?;
                if matches!(kind, 'x' | 'u') {
                    content.push_str(&fancy_regex::escape(&hex_literal(kind, chars)?.to_string()));
                } else {
                    content.push_str(&escape(kind, true)?);
                }
            }
            '[' | '&' => {
                content.push('\\');
                content.push(ch);
            }
            value => content.push(value),
        }
    }
    Ok(())
}

fn regex(pattern: &str, insensitive: bool) -> Result<Regex> {
    if pattern.len() > 4096 {
        bail!("custom route regex exceeds 4096 bytes");
    }
    let pattern = js_regex(pattern, insensitive)?;
    RegexBuilder::new(&pattern)
        .case_insensitive(insensitive)
        .backtrack_limit(10_000)
        .delegate_size_limit(1024 * 1024)
        .delegate_dfa_size_limit(1024 * 1024)
        .build()
        .context("invalid custom route regex")
}
impl CompiledRoutes {
    pub fn new(routes: Option<CustomRoutes>) -> Result<Self> {
        let Some(routes) = routes else {
            return Ok(Self::default());
        };
        if routes.version != 1 {
            bail!("unsupported custom routes version");
        }
        if routes.headers.len()
            + routes.redirects.len()
            + routes.rewrites.before_files.len()
            + routes.rewrites.after_files.len()
            + routes.rewrites.fallback.len()
            > 1000
        {
            bail!("too many custom routes");
        }
        Ok(Self {
            headers: Self::compile_matchers(routes.headers)?,
            redirects: Self::compile_matchers(routes.redirects)?,
            before: Self::compile_matchers(routes.rewrites.before_files)?,
            after: Self::compile_matchers(routes.rewrites.after_files)?,
            fallback: Self::compile_matchers(routes.rewrites.fallback)?,
        })
    }
    pub(crate) fn compile_matchers(rules: Vec<Rule>) -> Result<Vec<CompiledRule>> {
        if rules.len() > 1000 {
            bail!("too many route matchers");
        }
        rules
            .into_iter()
            .map(|rule| {
                if rule.keys.len() > 64
                    || rule.has.len() > 16
                    || rule.missing.len() > 16
                    || rule.headers.len() > 64
                {
                    bail!("custom route metadata exceeds bounds");
                }
                let compile_conditions = |conditions: &[Condition]| {
                    conditions
                        .iter()
                        .map(|c| {
                            if !matches!(c.kind.as_str(), "header" | "cookie" | "query" | "host") {
                                bail!("invalid custom condition");
                            }
                            c.regex.as_deref().map(|r| regex(r, false)).transpose()
                        })
                        .collect::<Result<Vec<_>>>()
                };
                Ok(CompiledRule {
                    regex: regex(&rule.regex, true)?,
                    has: compile_conditions(&rule.has)?,
                    missing: compile_conditions(&rule.missing)?,
                    rule,
                })
            })
            .collect()
    }
}
impl CompiledRule {
    pub fn captures(&self, uri: &Uri, headers: &HeaderMap) -> Result<Option<Captured>> {
        if uri.path().len() > MAX_URL || uri.query().is_some_and(|q| q.len() > MAX_URL) {
            bail!("custom route input exceeds bounds");
        }
        if uri.path().chars().any(|ch| ch as u32 > 0xffff) && !non_bmp_safe(&self.rule.regex) {
            return Err(UnsupportedRegexInput.into());
        }
        let Some(captures) = self
            .regex
            .captures(uri.path())
            .context("custom route match budget exceeded")?
        else {
            return Ok(None);
        };
        let mut params = Captured::new();
        for (index, key) in self.rule.keys.iter().enumerate() {
            if let (Some(name), Some(value)) = (&key.name, captures.get(index + 1)) {
                let values = if key.repeat && !key.separator.is_empty() {
                    value
                        .as_str()
                        .split(&key.separator)
                        .map(str::to_owned)
                        .collect()
                } else {
                    vec![value.as_str().to_owned()]
                };
                params.insert(
                    name.clone(),
                    Param {
                        values,
                        raw_path: true,
                    },
                );
            }
        }
        for (condition, regex) in self.rule.has.iter().zip(&self.has) {
            let Some(values) = condition_match(condition, regex.as_ref(), uri, headers)? else {
                return Ok(None);
            };
            params.extend(values);
        }
        for (condition, regex) in self.rule.missing.iter().zip(&self.missing) {
            if condition_match(condition, regex.as_ref(), uri, headers)?.is_some() {
                return Ok(None);
            }
        }
        Ok(Some(params))
    }
    pub fn headers(&self, params: &Captured, output: &mut HeaderMap) -> Result<()> {
        for header in &self.rule.headers {
            let name = HeaderName::from_bytes(expand(&header.key, params, false)?.as_bytes())?;
            // Framing and connection state are exclusively controlled by the server.
            if crate::server::is_hop_header(&name) || name == axum::http::header::CONTENT_LENGTH {
                continue;
            }
            let value = HeaderValue::from_str(&expand(&header.value, params, false)?)?;
            if name == axum::http::header::SET_COOKIE {
                output.append(name, value);
            } else {
                output.insert(name, value);
            }
        }
        Ok(())
    }
    pub fn status(&self) -> u16 {
        self.rule.status_code.unwrap_or(307)
    }
    pub fn target(&self, uri: &Uri, params: &Captured) -> Result<Target> {
        let destination = self
            .rule
            .destination
            .as_ref()
            .context("custom route destination missing")?;
        let pathname = expand(&destination.pathname, params, true)?;
        if !pathname.starts_with('/') || pathname.starts_with("//") || pathname.contains('\\') {
            bail!("invalid rewritten pathname");
        }
        let mut query: Vec<(String, String)> =
            reqwest::Url::parse(&format!("http://prnext.invalid{uri}"))?
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
        let mut replace = |key: &str, values: Vec<String>| {
            query.retain(|(name, _)| name != key);
            query.extend(values.into_iter().map(|value| (key.to_owned(), value)));
        };
        if destination.append_params_to_query {
            for (name, param) in params {
                replace(name, param.values.clone());
            }
        }
        let mut configured: Vec<(String, Vec<String>)> = Vec::new();
        for entry in &destination.query {
            let value = expand(&entry.value, params, false)?;
            if let Some((_, values)) = configured.iter_mut().find(|(key, _)| key == &entry.key) {
                values.push(value);
            } else {
                configured.push((entry.key.clone(), vec![value]));
            }
        }
        for (key, values) in configured {
            replace(&key, values);
        }
        let mut encoded = reqwest::Url::parse("http://prnext.invalid/")?;
        encoded.query_pairs_mut().extend_pairs(query);
        let search = encoded
            .query()
            .filter(|q| !q.is_empty())
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        let hash = expand(&destination.hash, params, true)?;
        let hash = if hash.is_empty() {
            hash
        } else {
            format!("#{hash}")
        };
        let origin = if destination.external {
            let protocol = destination
                .protocol
                .as_deref()
                .context("external protocol missing")?;
            if !matches!(protocol, "http" | "https") {
                bail!("unsupported rewrite protocol");
            }
            let hostname = expand(
                destination
                    .hostname
                    .as_ref()
                    .context("external hostname missing")?,
                params,
                false,
            )?;
            let port = destination
                .port
                .as_ref()
                .map(|p| format!(":{p}"))
                .unwrap_or_default();
            let authority = format!("{hostname}{port}");
            if authority.contains('@')
                || authority.contains('/')
                || authority.contains('\\')
                || authority.contains('?')
                || authority.contains('#')
                || authority.parse::<axum::http::uri::Authority>().is_err()
            {
                bail!("invalid rewritten authority");
            }
            format!("{protocol}://{authority}")
        } else {
            String::new()
        };
        let url = format!("{origin}{pathname}{search}{hash}");
        if url.len() > MAX_URL {
            bail!("expanded custom route exceeds URL bound");
        }
        Ok(Target {
            url,
            external: destination.external,
        })
    }
}
#[derive(Debug)]
pub struct UnsupportedRegexInput;
impl std::fmt::Display for UnsupportedRegexInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("custom regex requires unsupported UTF-16 code-unit matching")
    }
}
impl std::error::Error for UnsupportedRegexInput {}
// Scalar-based matching is equivalent for literal strings and a single greedy
// unbounded capture of non-BMP text. Width-constrained/splitting expressions are
// rejected for that input instead of silently matching one UTF-16 pair as one unit.
fn non_bmp_safe(pattern: &str) -> bool {
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut wide = 0;
    while index < chars.len() {
        let mut atom = false;
        match chars[index] {
            '\\' => {
                index += 1;
                if index >= chars.len() {
                    return false;
                }
                atom = matches!(chars[index], 'D' | 'W' | 'S');
            }
            '[' => {
                index += 1;
                let negative = chars.get(index) == Some(&'^');
                let mut complement = false;
                while index < chars.len() && chars[index] != ']' {
                    if chars[index] as u32 > 0xffff {
                        return false;
                    }
                    if chars[index] == '\\' {
                        index += 1;
                        complement |= chars
                            .get(index)
                            .is_some_and(|ch| matches!(ch, 'D' | 'W' | 'S'));
                    }
                    index += 1;
                }
                atom = negative || complement;
            }
            '.' => atom = true,
            ')' => {
                if chars
                    .get(index + 1)
                    .is_some_and(|ch| matches!(ch, '*' | '+' | '?' | '{'))
                {
                    return false;
                }
            }
            ch if ch as u32 > 0xffff
                && chars
                    .get(index + 1)
                    .is_some_and(|ch| matches!(ch, '*' | '+' | '?' | '{')) =>
            {
                return false
            }
            _ => {}
        }
        if atom {
            wide += 1;
            if !chars
                .get(index + 1)
                .is_some_and(|ch| matches!(ch, '*' | '+'))
                || chars.get(index + 2) == Some(&'?')
            {
                return false;
            }
        }
        index += 1;
    }
    wide <= 1
}

fn condition_match(
    condition: &Condition,
    regex: Option<&Regex>,
    uri: &Uri,
    headers: &HeaderMap,
) -> Result<Option<Captured>> {
    let key = condition.key.as_deref().unwrap_or("");
    let mut query_values = None;
    let value = match condition.kind.as_str() {
        "header" => headers
            .get_all(key)
            .iter()
            .next_back()
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        "host" => headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .and_then(|host| host.parse::<axum::http::uri::Authority>().ok())
            .map(|host| host.host().to_ascii_lowercase()),
        "query" => {
            let values = reqwest::Url::parse(&format!("http://prnext.invalid{uri}"))?
                .query_pairs()
                .filter(|(name, _)| name == key)
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>();
            let last = values.last().cloned();
            query_values = Some(values);
            last
        }
        "cookie" => {
            let mut cookies = HashMap::new();
            for header in headers.get_all("cookie") {
                if let Ok(header) = header.to_str() {
                    for part in header.split(';') {
                        if let Some((k, v)) = part.trim().split_once('=') {
                            // Node's cookie parser retains the first duplicate and decodes percent escapes.
                            let value = v.trim().trim_matches('"');
                            let value = percent_encoding::percent_decode_str(value)
                                .decode_utf8()
                                .map(|v| v.into_owned())
                                .unwrap_or_else(|_| value.to_owned());
                            cookies.entry(k).or_insert(value);
                        }
                    }
                }
            }
            cookies.remove(key)
        }
        _ => None,
    };
    let Some(value) = value
        .filter(|v| !v.is_empty() || query_values.as_ref().is_some_and(|values| values.len() > 1))
    else {
        return Ok(None);
    };
    if value.len() > MAX_VALUE {
        bail!("custom condition value exceeds bound");
    }
    let mut params = Captured::new();
    if let Some(regex) = regex {
        if value.chars().any(|ch| ch as u32 > 0xffff)
            && !non_bmp_safe(condition.regex.as_deref().unwrap_or(""))
        {
            return Err(UnsupportedRegexInput.into());
        }
        let Some(captures) = regex
            .captures(&value)
            .context("custom condition match budget exceeded")?
        else {
            return Ok(None);
        };
        for capture in &condition.captures {
            if let Some(value) = captures.get(capture.index) {
                params.insert(
                    capture.name.clone(),
                    Param {
                        values: vec![value.as_str().to_owned()],
                        raw_path: false,
                    },
                );
            }
        }
    }
    if let Some(name) = &condition.capture {
        params.insert(
            name.clone(),
            Param {
                values: if regex.is_none() {
                    query_values.unwrap_or_else(|| vec![value])
                } else {
                    vec![value]
                },
                raw_path: false,
            },
        );
    }
    Ok(Some(params))
}
fn expand(template: &Template, params: &Captured, path: bool) -> Result<String> {
    let mut output = String::new();
    for token in template {
        match token {
            Token::Text(text) => output.push_str(text),
            Token::Param {
                param,
                prefix,
                suffix,
                modifier,
                join,
            } => {
                let Some(value) = params.get(param) else {
                    if matches!(modifier.as_str(), "?" | "*") {
                        continue;
                    }
                    bail!("missing custom route parameter {param}");
                };
                for (index, value_part) in value.values.iter().enumerate() {
                    if index > 0 && !matches!(modifier.as_str(), "*" | "+") {
                        bail!("array parameter requires a repeat modifier");
                    }
                    if index == 0 || join.is_none() {
                        output.push_str(prefix);
                    } else if let Some(join) = join {
                        output.push_str(join);
                    }
                    if path && !value.raw_path {
                        const COMPONENT: &percent_encoding::AsciiSet =
                            &percent_encoding::NON_ALPHANUMERIC
                                .remove(b'-')
                                .remove(b'_')
                                .remove(b'.')
                                .remove(b'~');
                        output.extend(percent_encoding::utf8_percent_encode(value_part, COMPONENT));
                    } else {
                        output.push_str(value_part);
                    }
                    if index + 1 == value.values.len() || join.is_none() {
                        output.push_str(suffix);
                    }
                }
            }
        }
        if output.len() > MAX_URL {
            bail!("expanded custom route exceeds bound");
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn compiled(rule: serde_json::Value) -> CompiledRule {
        CompiledRoutes::new(Some(serde_json::from_value(serde_json::json!({"version":1,"headers":[],"redirects":[],"rewrites":{"beforeFiles":[rule],"afterFiles":[],"fallback":[]}})).unwrap())).unwrap().before.remove(0)
    }
    #[test]
    fn javascript_classes_and_boundaries_are_ascii_while_literals_remain_utf8() {
        for (pattern, yes, no) in [
            (r"^\d+$", "123", "١٢٣"),
            (r"^\w+$", "abc_123", "é"),
            (r"^\w+$", "Keys", "Keys"),
            (r"^[a-z]+$", "Keys", "Keys"),
            (r"^\W+$", "é", "a"),
            (r"^é\bword$", "éword", "éxword"),
            (r"^é\Bé$", "éé", "ée"),
            (r"^[\d_]+$", "123_", "١_"),
            (r"^[^\w]+$", "é", "a"),
            (r"^café/(.+)$", "café/東京", "cafe/東京"),
        ] {
            let matcher = regex(pattern, true).unwrap();
            assert!(matcher.is_match(yes).unwrap(), "{pattern}: {yes}");
            assert!(!matcher.is_match(no).unwrap(), "{pattern}: {no}");
        }
        let whitespace = regex(r"^\s$", false).unwrap();
        assert!(whitespace.is_match("\u{feff}").unwrap());
        assert!(!whitespace.is_match("\u{85}").unwrap());
        assert!(regex(r"\p{Letter}", true).is_err());
        assert!(regex(r"\Aword", true).is_err());
    }

    #[test]
    fn non_bmp_literals_and_whole_captures_work_but_code_unit_width_is_explicit() {
        for pattern in [
            r"^(?:🚀)$",
            r"^(?:(?<value>.+))$",
            r"^(?:(?<value>[^;]+))$",
            r"^\w+$",
        ] {
            assert!(non_bmp_safe(pattern), "{pattern}");
        }
        for pattern in [
            r"^.$",
            r"^.{2}$",
            r"^(..)$",
            r"^🚀+$",
            r"^(.+){2}$",
            r"^(.+)(.)$",
        ] {
            assert!(!non_bmp_safe(pattern), "{pattern}");
        }
        for (pattern, safe) in [
            (r"^(?:(?<value>.+))$", true),
            (r"^🚀$", true),
            (r"^.$", false),
        ] {
            let condition = Condition {
                kind: "query".into(),
                key: Some("value".into()),
                regex: Some(pattern.into()),
                captures: Vec::new(),
                capture: None,
            };
            let regex = regex(pattern, false).unwrap();
            let uri = "/?value=%F0%9F%9A%80".parse().unwrap();
            let result = condition_match(&condition, Some(&regex), &uri, &HeaderMap::new());
            if safe {
                assert!(result.unwrap().is_some());
            } else {
                assert!(result.unwrap_err().is::<UnsupportedRegexInput>());
            }
        }
    }

    #[test]
    fn query_presence_preserves_arrays_while_regex_uses_the_last_value() {
        let condition = Condition {
            kind: "query".into(),
            key: Some("tag".into()),
            regex: None,
            captures: Vec::new(),
            capture: Some("tag".into()),
        };
        let uri = "/?tag=one&tag=two".parse().unwrap();
        let params = condition_match(&condition, None, &uri, &HeaderMap::new())
            .unwrap()
            .unwrap();
        assert_eq!(params["tag"].values, ["one", "two"]);
        let template: Template = serde_json::from_value(
            serde_json::json!(["/target",{"param":"tag","prefix":"/","suffix":"","modifier":"*"}]),
        )
        .unwrap();
        assert_eq!(expand(&template, &params, true).unwrap(), "/target/one/two");
        assert!(condition_match(
            &condition,
            None,
            &"/?tag=".parse().unwrap(),
            &HeaderMap::new()
        )
        .unwrap()
        .is_none());
        assert_eq!(
            condition_match(
                &condition,
                None,
                &"/?tag=&tag=".parse().unwrap(),
                &HeaderMap::new()
            )
            .unwrap()
            .unwrap()["tag"]
                .values,
            ["", ""]
        );
        let regex = regex("^two$", false).unwrap();
        assert!(
            condition_match(&condition, Some(&regex), &uri, &HeaderMap::new())
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn repeated_query_templates_use_the_compiled_non_path_separator() {
        let params = BTreeMap::from([(
            "parts".into(),
            Param {
                values: vec!["a".into(), "b".into()],
                raw_path: true,
            },
        )]);
        for (join, expected) in [("/", "a/b"), ("", "ab"), (".", "a.b")] {
            let template:Template=serde_json::from_value(serde_json::json!([{"param":"parts","prefix":"","suffix":"","modifier":"*","join":join}])).unwrap();
            assert_eq!(expand(&template, &params, false).unwrap(), expected);
        }
    }

    #[test]
    fn negative_lookahead_and_raw_path_encoding_remain_distinct() {
        let rule = compiled(
            serde_json::json!({"source":"/:path((?!api).*)","regex":"^(?:/((?!api).*))$","keys":[{"name":"path","repeat":false,"separator":"/"}],"has":[],"missing":[],"destination":{"external":false,"pathname":["/target/",{"param":"path","prefix":"","suffix":"","modifier":""}],"query":[{"key":"from","value":[{"param":"path","prefix":"","suffix":"","modifier":""}]}],"hash":[],"appendParamsToQuery":false}}),
        );
        assert!(rule
            .captures(&"/api/a".parse().unwrap(), &HeaderMap::new())
            .unwrap()
            .is_none());
        let uri = "/a/b%2Fc?keep=yes".parse().unwrap();
        let params = rule.captures(&uri, &HeaderMap::new()).unwrap().unwrap();
        assert_eq!(
            rule.target(&uri, &params).unwrap().url,
            "/target/a/b%2Fc?keep=yes&from=a%2Fb%252Fc"
        );
    }
    #[test]
    fn conditions_capture_last_query_and_require_missing() {
        let rule = compiled(
            serde_json::json!({"source":"/","regex":"^/$","keys":[],"has":[{"type":"query","key":"x","regex":"^(?<value>yes)$","captures":[{"name":"value","index":1}]}],"missing":[{"type":"header","key":"skip","captures":[]}],"destination":{"external":false,"pathname":["/next"],"query":[],"hash":[],"appendParamsToQuery":true}}),
        );
        let uri = "/?x=no&x=yes".parse().unwrap();
        let mut headers = HeaderMap::new();
        let params = rule.captures(&uri, &headers).unwrap().unwrap();
        assert_eq!(
            rule.target(&uri, &params).unwrap().url,
            "/next?x=no&x=yes&value=yes"
        );
        headers.insert("skip", HeaderValue::from_static("1"));
        assert!(rule.captures(&uri, &headers).unwrap().is_none());
    }
}
