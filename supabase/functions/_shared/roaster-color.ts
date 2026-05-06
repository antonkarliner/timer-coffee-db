export const DEFAULT_RESIZE_TO = 64;
export const DEFAULT_RGBA_BYTE_LENGTH = DEFAULT_RESIZE_TO * DEFAULT_RESIZE_TO * 4;

const BORDER_WIDTH = 4;
const CHROMATIC_CHROMA_THRESHOLD = 3;
const FOREGROUND_CHROMATIC_SHARE_THRESHOLD = 0.02;
const MIN_CHROMATIC_PIXEL_COUNT = 8;
const SCORE_SATURATION_BOOST = 1.5;
const ACCENT_MIN_SATURATION = 0.55;
const ACCENT_SATURATION_FACTOR = 0.8;
const ACCENT_CHROMA_MARGIN = 2;
const ACCENT_WEIGHT_SATURATION_EXPONENT = 3;
const ACCENT_WEIGHT_CHROMA_EXPONENT = 2;

interface BucketStats {
  key: string;
  count: number;
  borderCount: number;
  centerWeightSum: number;
  sumR: number;
  sumG: number;
  sumB: number;
  rNibble: number;
  gNibble: number;
  bNibble: number;
  maxNibble: number;
  minNibble: number;
  chroma: number;
  saturation: number;
  luma: number;
}

type BackgroundKind = "white" | "black";

interface BackgroundBucket {
  bucket: BucketStats;
  kind: BackgroundKind;
}

interface ClusterStats {
  buckets: BucketStats[];
  count: number;
  borderCount: number;
  sumR: number;
  sumG: number;
  sumB: number;
  averageSaturation: number;
  averageLuma: number;
  maxChroma: number;
  maxSaturation: number;
  averageChroma: number;
}

export function quantizeNibble(channel: number): number {
  return Math.max(0, Math.min(15, Math.floor(channel / 16)));
}

export function nibbleToChannel(channel: number): number {
  return channel * 17;
}

export function toUpperHex(r: number, g: number, b: number): string {
  const hex = [r, g, b]
    .map((value) => value.toString(16).padStart(2, "0").toUpperCase())
    .join("");
  return `#${hex}`;
}

function bucketKeyFromChannels(r: number, g: number, b: number): string {
  return [quantizeNibble(r), quantizeNibble(g), quantizeNibble(b)].join(",");
}

function createBucketStats(key: string): BucketStats {
  const [rNibble, gNibble, bNibble] = key.split(",").map(Number);
  const maxNibble = Math.max(rNibble, gNibble, bNibble);
  const minNibble = Math.min(rNibble, gNibble, bNibble);
  const chroma = maxNibble - minNibble;
  const saturation = maxNibble === 0 ? 0 : chroma / maxNibble;
  const luma =
    (0.2126 * rNibble) + (0.7152 * gNibble) + (0.0722 * bNibble);

  return {
    key,
    count: 0,
    borderCount: 0,
    centerWeightSum: 0,
    sumR: 0,
    sumG: 0,
    sumB: 0,
    rNibble,
    gNibble,
    bNibble,
    maxNibble,
    minNibble,
    chroma,
    saturation,
    luma,
  };
}

function isBorderPixel(x: number, y: number, width: number, height: number): boolean {
  return x < BORDER_WIDTH ||
    y < BORDER_WIDTH ||
    x >= width - BORDER_WIDTH ||
    y >= height - BORDER_WIDTH;
}

function centerWeight(x: number, y: number, width: number, height: number): number {
  const normalizedX = width <= 1 ? 0 : x / (width - 1);
  const normalizedY = height <= 1 ? 0 : y / (height - 1);
  const dx = normalizedX - 0.5;
  const dy = normalizedY - 0.5;
  const distance = Math.sqrt((dx * dx) + (dy * dy));
  const maxDistance = Math.sqrt(0.5);

  return Math.max(0, 1 - (distance / maxDistance));
}

function isWhiteLike(bucket: BucketStats): boolean {
  return bucket.minNibble >= 10 && bucket.chroma <= 3;
}

function isBlackLike(bucket: BucketStats): boolean {
  return bucket.maxNibble <= 4 && bucket.chroma <= 3;
}

function detectBackgroundBucket(
  buckets: BucketStats[],
  borderOpaquePixelCount: number,
): BackgroundBucket | null {
  if (borderOpaquePixelCount === 0 || buckets.length === 0) {
    return null;
  }

  const topBorderBucket = buckets.reduce((winner, bucket) =>
    bucket.borderCount > winner.borderCount ? bucket : winner
  );

  if (topBorderBucket.borderCount === 0) {
    return null;
  }

  let kind: BackgroundKind | null = null;
  if (isWhiteLike(topBorderBucket)) {
    kind = "white";
  } else if (isBlackLike(topBorderBucket)) {
    kind = "black";
  } else {
    return null;
  }

  const clusterBorderPixelCount = buckets
    .filter((bucket) =>
      kind === "white" ? isWhiteLike(bucket) : isBlackLike(bucket)
    )
    .reduce((sum, bucket) => sum + bucket.borderCount, 0);

  if (clusterBorderPixelCount / borderOpaquePixelCount < 0.55) {
    return null;
  }

  return { bucket: topBorderBucket, kind };
}

function isBackgroundLike(bucket: BucketStats, background: BackgroundBucket): boolean {
  return background.kind === "white" ? isWhiteLike(bucket) : isBlackLike(bucket);
}

function chromaticScore(bucket: BucketStats): number {
  return bucket.count * (1 + (bucket.saturation * SCORE_SATURATION_BOOST));
}

function areNeighborBuckets(left: BucketStats, right: BucketStats): boolean {
  return Math.abs(left.rNibble - right.rNibble) <= 1 &&
    Math.abs(left.gNibble - right.gNibble) <= 1 &&
    Math.abs(left.bNibble - right.bNibble) <= 1;
}

function buildClusters(buckets: BucketStats[]): ClusterStats[] {
  if (buckets.length === 0) {
    return [];
  }

  const visited = new Set<string>();
  const clusters: ClusterStats[] = [];

  for (const seedBucket of buckets) {
    if (visited.has(seedBucket.key)) {
      continue;
    }

    const queue = [seedBucket];
    visited.add(seedBucket.key);
    const clusterBuckets: BucketStats[] = [];

    while (queue.length > 0) {
      const currentBucket = queue.shift()!;
      clusterBuckets.push(currentBucket);

      for (const candidateBucket of buckets) {
        if (visited.has(candidateBucket.key)) {
          continue;
        }

        if (!areNeighborBuckets(currentBucket, candidateBucket)) {
          continue;
        }

        visited.add(candidateBucket.key);
        queue.push(candidateBucket);
      }
    }

    const count = clusterBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const borderCount = clusterBuckets.reduce(
      (sum, bucket) => sum + bucket.borderCount,
      0,
    );
    const sumR = clusterBuckets.reduce((sum, bucket) => sum + bucket.sumR, 0);
    const sumG = clusterBuckets.reduce((sum, bucket) => sum + bucket.sumG, 0);
    const sumB = clusterBuckets.reduce((sum, bucket) => sum + bucket.sumB, 0);
    const averageSaturation = clusterBuckets.reduce(
      (sum, bucket) => sum + (bucket.saturation * bucket.count),
      0,
    ) / count;
    const averageLuma = clusterBuckets.reduce(
      (sum, bucket) => sum + (bucket.luma * bucket.count),
      0,
    ) / count;
    const averageChroma = clusterBuckets.reduce(
      (sum, bucket) => sum + (bucket.chroma * bucket.count),
      0,
    ) / count;
    const maxChroma = clusterBuckets.reduce((max, bucket) =>
      Math.max(max, bucket.chroma)
    , 0);
    const maxSaturation = clusterBuckets.reduce((max, bucket) =>
      Math.max(max, bucket.saturation)
    , 0);

    clusters.push({
      buckets: clusterBuckets,
      count,
      borderCount,
      sumR,
      sumG,
      sumB,
      averageSaturation,
      averageLuma,
      maxChroma,
      maxSaturation,
      averageChroma,
    });
  }

  return clusters;
}

function clusterScore(cluster: ClusterStats): number {
  return cluster.count *
    (1 + (cluster.averageSaturation * SCORE_SATURATION_BOOST));
}

function weightedColorFromBuckets(
  buckets: BucketStats[],
  saturationExponent = 0,
  chromaExponent = 0,
): string {
  let totalWeight = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (const bucket of buckets) {
    const weight = bucket.count *
      (bucket.saturation ** saturationExponent) *
      (bucket.chroma ** chromaExponent);

    totalWeight += weight;
    sumR += (bucket.sumR / bucket.count) * weight;
    sumG += (bucket.sumG / bucket.count) * weight;
    sumB += (bucket.sumB / bucket.count) * weight;
  }

  return toUpperHex(
    Math.round(sumR / totalWeight),
    Math.round(sumG / totalWeight),
    Math.round(sumB / totalWeight),
  );
}

function bucketColor(bucket: BucketStats): string {
  return toUpperHex(
    Math.round(bucket.sumR / bucket.count),
    Math.round(bucket.sumG / bucket.count),
    Math.round(bucket.sumB / bucket.count),
  );
}

function dominantBucket(
  cluster: ClusterStats,
  preferCenter = false,
): BucketStats {
  return cluster.buckets.reduce((winner, bucket) => {
    if (preferCenter && bucket.centerWeightSum !== winner.centerWeightSum) {
      return bucket.centerWeightSum > winner.centerWeightSum ? bucket : winner;
    }

    if (bucket.count !== winner.count) {
      return bucket.count > winner.count ? bucket : winner;
    }

    if (bucket.saturation !== winner.saturation) {
      return bucket.saturation > winner.saturation ? bucket : winner;
    }

    return bucket.chroma > winner.chroma ? bucket : winner;
  });
}

function chooseCluster(
  buckets: BucketStats[],
  background: BackgroundBucket | null,
): ClusterStats {
  const foregroundBuckets = background
    ? buckets.filter((bucket) => !isBackgroundLike(bucket, background))
    : buckets;

  if (foregroundBuckets.length === 0) {
    return buildClusters(buckets).reduce((winner, cluster) =>
      cluster.count > winner.count ? cluster : winner
    );
  }

  const foregroundClusters = buildClusters(foregroundBuckets);
  const bestForegroundByScore = foregroundClusters.reduce((winner, cluster) =>
    clusterScore(cluster) > clusterScore(winner) ? cluster : winner
  );

  if (!background) {
    return bestForegroundByScore;
  }

  const bestForegroundByCount = foregroundClusters.reduce((winner, cluster) =>
    cluster.count > winner.count ? cluster : winner
  );

  const foregroundPixelCount = foregroundClusters.reduce(
    (sum, cluster) => sum + cluster.count,
    0,
  );
  const chromaticCandidates = foregroundClusters.filter((cluster) =>
    cluster.maxChroma >= CHROMATIC_CHROMA_THRESHOLD &&
    cluster.count >= Math.max(
      MIN_CHROMATIC_PIXEL_COUNT,
      Math.floor(foregroundPixelCount * FOREGROUND_CHROMATIC_SHARE_THRESHOLD),
    ) &&
    cluster.maxSaturation >= 0.35
  );

  if (chromaticCandidates.length === 0) {
    return bestForegroundByScore;
  }

  const bestChromaticCluster = chromaticCandidates.reduce((winner, cluster) =>
    clusterScore(cluster) > clusterScore(winner) ? cluster : winner
  );

  if (bestForegroundByCount.maxChroma < CHROMATIC_CHROMA_THRESHOLD) {
    return bestChromaticCluster;
  }

  if (clusterScore(bestChromaticCluster) >= clusterScore(bestForegroundByCount) * 0.3) {
    return bestChromaticCluster;
  }

  return bestForegroundByScore;
}

function colorFromCluster(
  cluster: ClusterStats,
  background: BackgroundBucket | null,
): string {
  const accentBuckets = cluster.buckets.filter((bucket) =>
    bucket.chroma >= Math.max(
      CHROMATIC_CHROMA_THRESHOLD + ACCENT_CHROMA_MARGIN,
      cluster.maxChroma - ACCENT_CHROMA_MARGIN,
    ) &&
    bucket.saturation >= Math.max(
      ACCENT_MIN_SATURATION,
      cluster.maxSaturation * ACCENT_SATURATION_FACTOR,
    )
  );

  if (accentBuckets.length > 0) {
    return weightedColorFromBuckets(
      accentBuckets,
      ACCENT_WEIGHT_SATURATION_EXPONENT,
      ACCENT_WEIGHT_CHROMA_EXPONENT,
    );
  }

  if (!background) {
    return bucketColor(dominantBucket(cluster, true));
  }

  if (cluster.maxChroma < CHROMATIC_CHROMA_THRESHOLD) {
    const inkBucket = cluster.buckets.reduce((winner, bucket) => {
      const winnerContrast = background.kind === "white"
        ? 15 - winner.luma
        : winner.luma;
      const bucketContrast = background.kind === "white"
        ? 15 - bucket.luma
        : bucket.luma;
      const winnerScore = winner.count * (1 + (winnerContrast * 0.08));
      const bucketScore = bucket.count * (1 + (bucketContrast * 0.08));

      return bucketScore > winnerScore ? bucket : winner;
    });

    return bucketColor(inkBucket);
  }

  return bucketColor(dominantBucket(cluster));
}

export function extractRepresentativeColorHexFromRgba(
  rgbaBytes: Uint8Array,
  width: number = DEFAULT_RESIZE_TO,
  height: number = DEFAULT_RESIZE_TO,
): string | null {
  if (rgbaBytes.length !== width * height * 4) {
    throw new Error(
      `Unexpected RGBA payload size ${rgbaBytes.length}, expected ${width * height * 4}`,
    );
  }

  const buckets = new Map<string, BucketStats>();
  let opaquePixelCount = 0;
  let borderOpaquePixelCount = 0;

  for (let index = 0; index < rgbaBytes.length; index += 4) {
    const a = rgbaBytes[index + 3];
    if (a === 0) {
      continue;
    }

    const pixelIndex = index / 4;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const key = bucketKeyFromChannels(
      rgbaBytes[index],
      rgbaBytes[index + 1],
      rgbaBytes[index + 2],
    );

    const bucket = buckets.get(key) ?? createBucketStats(key);
    bucket.count += 1;
    bucket.sumR += rgbaBytes[index];
    bucket.sumG += rgbaBytes[index + 1];
    bucket.sumB += rgbaBytes[index + 2];
    bucket.centerWeightSum += centerWeight(x, y, width, height);
    opaquePixelCount += 1;

    if (isBorderPixel(x, y, width, height)) {
      bucket.borderCount += 1;
      borderOpaquePixelCount += 1;
    }

    buckets.set(key, bucket);
  }

  if (opaquePixelCount === 0 || buckets.size === 0) {
    return null;
  }

  const bucketList = [...buckets.values()];
  const backgroundBucket = detectBackgroundBucket(
    bucketList,
    borderOpaquePixelCount,
  );
  const winner = chooseCluster(bucketList, backgroundBucket);

  return colorFromCluster(winner, backgroundBucket);
}
