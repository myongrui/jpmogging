export function displayCurrency(code: string): string {
  if (!/^[0-9A-F]{40}$/i.test(code)) return code;
  const bytes = Buffer.from(code, "hex");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const text = bytes.subarray(0, end).toString("latin1");
  if (text.length === 0 || !/^[\x20-\x7E]+$/.test(text)) return code;
  return text;
}
