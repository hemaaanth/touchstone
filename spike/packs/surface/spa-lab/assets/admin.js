// Loaded only on the admin route.
export function render() {
  return fetch('/api/v1/admin/export').then(r => r.text());
}
