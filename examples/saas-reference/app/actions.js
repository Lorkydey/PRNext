'use server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getAuth } from '../lib/auth.js';
import { getDatabase, getPool, notes } from '../lib/database.js';
import { consumeAuthenticationBudget } from '../lib/auth-limits.js';
import { required } from '../lib/environment.js';
import { safeLocale } from '../i18n/routing.js';

export async function authenticate(previous, form) {
  const locale = safeLocale(form.get('locale'));
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  const registering = form.get('mode') === 'sign-up';
  if (!email || email.length > 254 || password.length < 12 || password.length > 128) return { error: registering ? 'registration' : 'credentials' };
  const name = registering ? String(form.get('name') || '').trim() : undefined;
  if (registering && (!name || name.length > 100)) return { error: 'registration' };
  try {
    if (!(await consumeAuthenticationBudget(getPool(), {
      email, registering, secret: required('BETTER_AUTH_SECRET'),
    }))) return { error: 'rateLimited' };
  } catch { return { error: 'authUnavailable' }; }
  try {
    const options = { headers: await headers(), body: { email, password } };
    if (registering) {
      await getAuth().api.signUpEmail({ ...options, body: { ...options.body, name } });
    } else await getAuth().api.signInEmail(options);
  } catch { return { error: registering ? 'registration' : 'credentials' }; }
  redirect('/' + locale + '/dashboard');
}

export async function saveNote(previous, form) {
  const locale = safeLocale(form.get('locale'));
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return { error: 'authentication' };
  const body = String(form.get('body') || '').trim();
  if (!body || body.length > 500) return { error: 'required' };
  try { await getDatabase().insert(notes).values({ id: randomUUID(), userId: session.user.id, body }); }
  catch { return { error: 'failed' }; }
  revalidatePath('/' + locale + '/dashboard');
  return { saved: true };
}

export async function deleteNote(form) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return;
  const id = String(form.get('id') || '');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return;
  await getDatabase().delete(notes).where(and(eq(notes.id, id), eq(notes.userId, session.user.id)));
  revalidatePath('/' + safeLocale(form.get('locale')) + '/dashboard');
}

export async function signOut(form) {
  await getAuth().api.signOut({ headers: await headers() });
  redirect('/' + safeLocale(form.get('locale')) + '/sign-in');
}

export async function revokeOtherSessions(previous, form) {
  try { await getAuth().api.revokeOtherSessions({ headers: await headers() }); }
  catch { return { error: 'authentication' }; }
  return { updated: true };
}

export async function signInOidc(form) {
  const locale = safeLocale(form.get('locale'));
  const result = await getAuth().api.signInSocial({
    headers: await headers(),
    body: { provider: 'oidc', callbackURL: '/' + locale + '/dashboard' },
  });
  if (!result.url) throw new Error('The identity provider is unavailable.');
  redirect(result.url);
}
