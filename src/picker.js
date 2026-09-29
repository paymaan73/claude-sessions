import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useEffect,
  useMemo,
  isEnterKey,
  isUpKey,
  isDownKey,
  makeTheme,
} from '@inquirer/core';
import { c, theme as baseTheme } from './ui.js';

// Every whitespace-separated word has to appear in the project path, title or first prompt.
function filter(rows, term) {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => words.every((w) => r.haystack.includes(w)));
}

/**
 * Searchable session list with a fixed column header.
 * config: { message, header, rows: [{ value, name, short, description, haystack }], pageSize, initial }
 */
export const pickSession = createPrompt((config, done) => {
  const theme = makeTheme(baseTheme, config.theme);
  const [status, setStatus] = useState('idle');
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const prefix = usePrefix({ status, theme });
  const results = useMemo(() => filter(config.rows, term), [term]);

  useEffect((rl) => {
    if (config.initial) {
      rl.write(config.initial);
      setTerm(config.initial);
    }
  }, []);

  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      const picked = results[active];
      if (picked) {
        setStatus('done');
        done(picked.value);
      } else {
        rl.write(term); // readline clears the line on enter; put the search back
      }
    } else if (key.name === 'escape') {
      rl.clearLine(0);
      setTerm('');
      setActive(0);
    } else if (isUpKey(key) || isDownKey(key)) {
      rl.clearLine(0);
      rl.write(term);
      if (results.length) setActive(Math.min(results.length - 1, Math.max(0, active + (isUpKey(key) ? -1 : 1))));
    } else if (rl.line !== term) {
      setTerm(rl.line);
      setActive(0);
    }
  });

  const page = usePagination({
    items: results,
    active,
    pageSize: config.pageSize,
    loop: false,
    renderItem: ({ item, isActive }) =>
      isActive ? `${theme.icon.cursor} ${theme.style.highlight(item.name)}` : `  ${item.name}`,
  });

  const message = theme.style.message(config.message, status);
  if (status === 'done') return `${prefix} ${message} ${theme.style.answer(results[active].short)}`;

  const count = term ? `${results.length}/${config.rows.length}` : `${config.rows.length}`;
  const help = [
    ['↑↓', 'move'],
    ['type', 'filter by project / title'],
    ['esc', 'clear'],
    ['⏎', 'resume'],
  ]
    .map(([k, v]) => `${theme.style.key(k)} ${c.gray(v)}`)
    .join(c.slate('  ·  '));

  const body = results.length
    ? [config.header, page, ' ', results[active]?.description || '']
    : [config.header, c.gray(`  No sessions match “${term}”`), ' '];
  body.push(`${help}${c.slate('   ' + count + ' sessions')}`);

  return [`${prefix} ${message} ${c.orange('›')} ${term}`, body.join('\n')];
});
