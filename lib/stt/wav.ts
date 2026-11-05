/**
 * WAV の長さ（秒）を、RIFF・WAVE・fmt の byteRate と data の大きさから求める。純粋な関数。
 * WAV でない・必要な塊が無い・data が途中で切れているなら throw する（長さを推測しない）。
 */
export function wavDurationSec(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
  if (data.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("WAV でない（RIFF・WAVE が無い）");
  }
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  let at = 12;
  while (at + 8 <= data.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > data.byteLength) throw new Error("WAV の fmt が短い");
      byteRate = view.getUint32(body + 8, true);
    } else if (id === "data") {
      if (body + size > data.byteLength) throw new Error("WAV の data が途中で切れている");
      dataSize = size;
    }
    if (byteRate !== null && dataSize !== null) break;
    at = body + size + (size % 2);
  }
  if (byteRate === null) throw new Error("WAV に fmt が無い");
  if (dataSize === null) throw new Error("WAV に data が無い");
  if (byteRate <= 0) throw new Error("WAV の byteRate が 0");
  return dataSize / byteRate;
}
