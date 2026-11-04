const PREVIOUS_PRESET_LABELS: [string, string][] = [
  ['Claude · Claude Code sign-in on this Mac', 'Claude · Claude Code sign-in on this computer'],
  ['Codex · ChatGPT sign-in on this Mac', 'Codex · ChatGPT sign-in on this computer'],
  ['Cursor · Cursor sign-in on this Mac', 'Cursor · Cursor sign-in on this computer'],
  ['Claude · sesión de Claude Code de esta Mac', 'Claude · sesión de Claude Code de esta computadora'],
  ['Codex · sesión de ChatGPT de esta Mac', 'Codex · sesión de ChatGPT de esta computadora'],
  ['Cursor · sesión de Cursor de esta Mac', 'Cursor · sesión de Cursor de esta computadora'],
];

/** Update only the old built-in labels, including a model appended to a past turn. */
export function currentProfileLabel(label: string): string {
  for (const [old, current] of PREVIOUS_PRESET_LABELS) {
    if (label === old || label.startsWith(`${old} · `)) return current + label.slice(old.length);
  }
  return label;
}
