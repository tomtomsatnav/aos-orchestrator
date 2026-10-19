// Conservative shell command tokeniser for the policy engine. It does not execute anything.
// Splits on ; && || | & newline (outside quotes), strips quotes/escapes, extracts redirections,
// and flags constructs it cannot reason about (substitution, expansion, heredoc, subshell).

const OPS = new Set([';', '&&', '||', '|', '&', '\n']);

export function parseShell(input) {
  const src = String(input ?? '');
  const flags = { substitution: false, expansion: false, heredoc: false, subshell: false, unterminated: false };
  const commands = [];
  let cur = { argv: [], redirects: [], ops: null };
  let word = null; // null = no word in progress ('' is a legitimately empty quoted word)
  let pendingRedirect = null;
  const pushWord = () => {
    if (word === null) return;
    if (pendingRedirect) { cur.redirects.push({ op: pendingRedirect, target: word }); pendingRedirect = null; } else cur.argv.push(word);
    word = null;
  };
  const endCommand = (op) => {
    pushWord();
    if (cur.argv.length || cur.redirects.length) commands.push(cur);
    cur = { argv: [], redirects: [], ops: op };
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; } // line continuation: the shell removes backslash-newline entirely
      word = (word ?? '') + (src[i + 1] ?? ''); i += 2; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) { flags.unterminated = true; word = (word ?? '') + src.slice(i + 1); break; }
      word = (word ?? '') + src.slice(i + 1, j); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let buf = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') { if (src[j + 1] !== '\n') buf += src[j + 1] ?? ''; j++; continue; }
        if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) flags.substitution = true;
        else if (src[j] === '$' && /[A-Za-z_{@*#?0-9!$[-]/.test(src[j + 1] || '')) flags.expansion = true;
        buf += src[j];
      }
      if (j >= src.length) flags.unterminated = true;
      word = (word ?? '') + buf; i = j + 1; continue;
    }
    if (c === '`') { flags.substitution = true; word = (word ?? '') + c; i++; continue; }
    if (c === '$') {
      if (src[i + 1] === '(') flags.substitution = true;
      // $VAR, ${..}, $'..' (ANSI-C: \x2f is '/'), $"..", $[..], $$ ...: anything but a lone trailing '$' expands
      else if (src[i + 1] !== undefined && !/[\s;|&<>)]/.test(src[i + 1])) flags.expansion = true;
      word = (word ?? '') + c; i++; continue;
    }
    // brace expansion ({/etc/passwd,x}) and brace groups produce words the policy never sees
    if (c === '{') { flags.expansion = true; word = (word ?? '') + c; i++; continue; }
    // tilde-prefix other than ~ and ~/ (~user, ~+, ~-) expands to a directory the policy cannot know
    if (c === '~' && word === null && src[i + 1] !== undefined && !/[\s/;|&<>()]/.test(src[i + 1])) flags.expansion = true;
    // a path segment '.' followed by a wildcard (.*, .?, .[) also matches '..' in bash: cat .*/x reads the parent
    if ((c === '*' || c === '?' || c === '[') && word !== null && (word === '.' || word.endsWith('/.'))) flags.expansion = true;
    if (c === '(' || c === ')') { flags.subshell = true; endCommand(c); i++; continue; }
    if (c === '<' && src[i + 1] === '(') { flags.substitution = true; i += 2; continue; }
    if (c === '>' || c === '<') {
      // an all-digit word right before the operator is a file descriptor, drop it
      if (word !== null && /^\d+$/.test(word)) word = null; else pushWord();
      let op = c;
      if (src[i + 1] === c) { op = c + c; if (op === '<<') flags.heredoc = true; } else if (src[i + 1] === '&') op = c + '&';
      if (op === '<<' && src[i + 2] === '<') { op = '<<<'; }
      i += op.length;
      if (op === '<<' || op === '<<<') { /* the delimiter word follows; treat as a read target */ }
      pendingRedirect = op;
      continue;
    }
    if (c === '&' && src[i + 1] === '>') { pushWord(); i += 2; pendingRedirect = '&>'; continue; }
    if (c === ' ' || c === '\t') { pushWord(); i++; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      let op = c;
      if ((c === '&' || c === '|') && src[i + 1] === c) op = c + c;
      endCommand(op); i += op.length; continue;
    }
    if (c === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
    word = (word ?? '') + c; i++;
  }
  endCommand(null);
  return { commands, flags, raw: src };
}

/** Tokenise an allowlist entry like "node --test" into argv. */
export const tokenize = (s) => parseShell(s).commands[0]?.argv || [];

export const WRITE_REDIRECTS = new Set(['>', '>>', '&>', '>&']);
