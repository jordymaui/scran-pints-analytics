import { createTikTokConnectionHandler } from '../../lib/tiktok-oauth.mjs';
import { createCloudStore } from '../../lib/cloud-store.mjs';

export default createTikTokConnectionHandler({ storeFactory: createCloudStore });
