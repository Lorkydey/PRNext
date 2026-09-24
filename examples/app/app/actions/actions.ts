'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function increment(step: number) {
  if (!Number.isInteger(step) || Math.abs(step) > 10) throw new Error('Invalid counter step');
  const store = await cookies();
  const previous = Number(store.get('rx-count')?.value || '0');
  const value = (Number.isFinite(previous) ? previous : 0) + step;
  store.set('rx-count', String(value), { httpOnly: true, sameSite: 'lax' });
  return { value, at: new Date(), tags: new Map([['source', 'server']]) };
}

export async function saveName(data: FormData) {
  const name = String(data.get('name') || '').trim();
  if (!name || name.length > 40) throw new Error('A name between 1 and 40 characters is required');
  await new Promise(resolve => setTimeout(resolve, 80));
  (await cookies()).set('rx-name', name, { httpOnly: true, sameSite: 'lax' });
}

export async function greet(previous: { message: string; submitted: number }, data: FormData) {
  const name = String(data.get('name') || '').trim();
  if (!name) return { ...previous, message: 'Please enter a name' };
  await saveName(data);
  return { message: `Hello, ${name}!`, submitted: previous.submitted + 1 };
}

export async function redirectAfterSave() {
  (await cookies()).set('rx-redirect', 'saved', { httpOnly: true, sameSite: 'lax' });
  redirect('/actions?redirected=1');
}

export async function failAction() {
  throw new Error('RUSTYX_ACTION_PRIVATE_ERROR_DO_NOT_SEND');
}
