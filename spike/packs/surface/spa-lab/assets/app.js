// A small single-page app. The HTML has no links. Only this bundle knows the routes.
const routes = {
  '/': () => '<h1>Vault</h1>',
  '/dashboard': () => '<h1>Dashboard</h1>',
  '/settings/api-keys': () => '<h1>API keys</h1>',
  '/admin/users': () => import('/assets/admin.js').then(m => m.render()),
};
async function session() {
  const res = await fetch('/api/v1/session', { credentials: 'include' });
  return res.json();
}
async function withdraw(amount) {
  return fetch('/api/v1/withdrawals', { method: 'POST', body: JSON.stringify({ amount }) });
}
// A path built at run time. Only a JavaScript parser sees its shape.
async function wallets(id) {
  return fetch('/api/v1/users/' + id + '/wallets');
}
// The AWS documentation example key pair. It is not a real key.
const storage = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', bucket: 'vault-uploads' };
// A link to another host. A scoped crawl must not follow it.
const status = 'http://localhost:__PORT__/status';
function render(path) {
  const view = routes[path] ?? routes['/'];
  document.getElementById('root').innerHTML = view();
}
window.addEventListener('popstate', () => render(location.pathname));
render(location.pathname);
export { session, withdraw, wallets, storage, status };
