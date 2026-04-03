export function compareVersionStrings(left, right) {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for(let index = 0; index < length; index += 1){
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}
function normalizeVersion(input) {
  return input.split(".").map((segment)=>{
    const match = segment.trim().match(/\d+/);
    return match ? Number(match[0]) : 0;
  });
}
