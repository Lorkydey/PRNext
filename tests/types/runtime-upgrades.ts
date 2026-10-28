import {useOffline} from '@thomas.f/prnext/offline';
import {createRedisCache} from '@thomas.f/prnext/cache/redis';
const offline:boolean=useOffline();
const cache=createRedisCache({namespace:'types-test',urlEnv:'REDIS_URL',leaseMs:30000});
const update:Promise<void>=cache.updateTags(['products'],{expire:0});
// @ts-expect-error the application namespace is required
createRedisCache({});
// @ts-expect-error named environment variables are strings
createRedisCache({namespace:'test',urlEnv:42});
void offline;void update;
