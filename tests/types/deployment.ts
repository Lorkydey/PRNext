import type {NextConfig} from '@thomas.f/prnext';
const bounded:NextConfig={deploymentRetention:{maxAge:600,maxGenerations:2,maxBytes:16*1024*1024}};
const revoked:NextConfig={deploymentRetention:false};
// @ts-expect-error Use false or a bounded options object.
const invalid:NextConfig={deploymentRetention:true};
// @ts-expect-error Unknown policy fields are rejected.
const unknown:NextConfig={deploymentRetention:{unlimited:true}};
