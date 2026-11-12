import { readFile, writeFile, rm } from 'node:fs/promises';
const data = JSON.parse(await readFile('.release/previous.json', 'utf8'));
const items = data.items ?? (data.kind ? [data] : []);
if (items.some(item => item.kind === 'Deployment')) {
  const order = ['ConfigMap', 'Service', 'PodDisruptionBudget', 'Deployment'];
  for (const item of items) {
    delete item.status;
    for (const key of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields']) delete item.metadata[key];
    if (item.metadata.annotations) delete item.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
  }
  items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  await writeFile('.release/rollback.json', JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
} else {
  await rm('.release/rollback.json', { force: true });
}
