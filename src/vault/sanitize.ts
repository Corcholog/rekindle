/**
 * Neutralizes markdown that could act, embed or impersonate inside an Obsidian vault.
 * Model output is derived from untrusted web pages, so every vault writer passes text
 * through here. Plain prose, links and [[wikilinks]] stay readable.
 */
export function sanitizeForVault(text: string, maxLength = 4000): string {
  let out = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

  out = out
    .replace(/</g, '&lt;')                       // raw HTML and Templater <% %>
    .replace(/`{3,}/g, m => '\\`'.repeat(m.length)) // code fences (dataviewjs etc.)
    .replace(/~{3,}/g, m => '\\~'.repeat(m.length))
    .replace(/`(\$?=)/g, '\\`$1')                // Dataview inline queries
    .replace(/!\[/g, '!\\[')                     // ![[embeds]] and ![images](remote)
    .replace(/\[!/g, '\\[!')                     // forged callouts
    .replace(/%%/g, '\\%\\%')                    // hidden Obsidian comments
    .replace(/^(\s*)>/gm, '$1\\>');              // nested blockquotes / callout breakout

  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength)}…`;
  }
  return out;
}

/** Double-quoted YAML scalar. */
export function yamlString(value: string): string {
  return JSON.stringify(sanitizeForVault(value, 300).replace(/\n/g, ' '));
}
