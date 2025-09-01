export function makeChatId(a: string, b: string) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}
