import type {Context} from 'react';
import {useRouter} from '../../../navigation.cjs';
export const AppRouterContext: Context<ReturnType<typeof useRouter> | null>;
