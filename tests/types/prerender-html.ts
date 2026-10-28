import type {NextConfig} from '@thomas.f/prnext';
const configured:NextConfig={prerender:{workers:2,maxMemoryMb:1024},htmlOnly:['/about','/articles/[slug]']};
// @ts-expect-error Resource budgets are numeric.
const invalidBudget:NextConfig={prerender:{maxMemoryMb:'unlimited'}};
// @ts-expect-error Unknown options are rejected.
const invalidWorkerOption:NextConfig={prerender:{unlimited:true}};
// @ts-expect-error HTML-only routes must be an explicit list.
const invalidHtml:NextConfig={htmlOnly:true};
