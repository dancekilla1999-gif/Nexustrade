// Простая логистическая регрессия с L2-регуляризацией и стандартизацией
// признаков. Обучается градиентным спуском (полный батч), без внешних
// зависимостей — чтобы веса можно было один в один перенести в index.html
// как массив чисел (скалярное произведение + сигмоида).

export function fitStandardizer(X) {
  const n = X.length, d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const row of X) for (let j = 0; j < d; j++) { const dd = row[j] - mean[j]; std[j] += dd * dd; }
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  return { mean, std };
}
export function standardize(X, sc) {
  return X.map(row => row.map((v, j) => (v - sc.mean[j]) / sc.std[j]));
}

function sigmoid(z) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)); }

// X уже стандартизован. Возвращает {w[d], b}.
export function trainLogReg(X, y, { l2 = 1.0, lr = 0.1, iters = 800, w0 = null, b0 = 0 } = {}) {
  const n = X.length, d = X[0].length;
  let w = w0 ? w0.slice() : new Array(d).fill(0);
  let b = b0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const row = X[i];
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * row[j];
      const p = sigmoid(z);
      const err = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * row[j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j] / n);
    b -= lr * (gb / n);
  }
  return { w, b };
}

export function predictProba(X, model) {
  return X.map(row => {
    let z = model.b;
    for (let j = 0; j < row.length; j++) z += model.w[j] * row[j];
    return sigmoid(z);
  });
}

export function auc(yTrue, pScore) {
  // ранговый AUC (Mann-Whitney), O(n log n)
  const idx = pScore.map((p, i) => i).sort((a, b) => pScore[a] - pScore[b]);
  const rank = new Array(pScore.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && pScore[idx[j + 1]] === pScore[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k]] = avgRank;
    i = j + 1;
  }
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let k = 0; k < yTrue.length; k++) {
    if (yTrue[k] === 1) { sumPos += rank[k]; nPos++; } else nNeg++;
  }
  if (!nPos || !nNeg) return NaN;
  return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}
