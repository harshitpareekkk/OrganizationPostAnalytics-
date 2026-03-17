export const hasMetricsChanged = (oldData, newData) => {
  if (!oldData) return true; // no old data → treat as changed (new)

  return Object.keys(newData).some(
    (key) => oldData[key] !== newData[key]
  );
};