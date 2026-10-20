import { createYouTubeConnectionHandler } from '../../lib/youtube-oauth.mjs';
import { createCloudStore } from '../../lib/cloud-store.mjs';

export default createYouTubeConnectionHandler({ storeFactory: createCloudStore });
