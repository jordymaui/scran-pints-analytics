import { createInstagramConnectionHandler } from '../../lib/instagram-oauth.mjs';
import { createCloudStore } from '../../lib/cloud-store.mjs';

export default createInstagramConnectionHandler({ storeFactory: createCloudStore });
