import { createInstagramConnectionHandler } from '../../lib/instagram-oauth.mjs';
import { createCloudStore } from '../../lib/cloud-store.mjs';
import browserHandler from '../../lib/instagram-browser-route.mjs';

const oauthHandler = createInstagramConnectionHandler({ storeFactory: createCloudStore });
export default function instagramConnection(req, res) {
  const url = new URL(req.url, 'https://internal.invalid');
  return req.query?.browser === '1' || url.searchParams.get('browser') === '1'
    ? browserHandler(req, res) : oauthHandler(req, res);
}
