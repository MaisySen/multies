/** R24 polish: the keyboard alternative to dragging a widget. Moves one widget up or down by one place. */
export function moveWidget<T extends { id: string }>(list: T[], id: string, dir: -1 | 1): T[] {
  const i = list.findIndex((w) => w.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
