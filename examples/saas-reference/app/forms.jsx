'use client';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { authenticate, saveNote, revokeOtherSessions } from './actions.js';

export function AuthForm({ locale, mode }) {
  const t = useTranslations('App');
  const [state, action, pending] = useActionState(authenticate, {});
  return <form action={action} aria-busy={pending}>
    <input type="hidden" name="locale" value={locale} /><input type="hidden" name="mode" value={mode} />
    {mode === 'sign-up' && <><label htmlFor="name">{t('name')}</label><input id="name" name="name" autoComplete="name" required maxLength={100} /></>}
    <label htmlFor="email">{t('email')}</label><input id="email" name="email" type="email" autoComplete="email" required maxLength={254} aria-describedby={state.error ? 'auth-error' : undefined} />
    <label htmlFor="password">{t('password')}</label><input id="password" name="password" type="password" autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} aria-describedby="password-hint" />
    <p id="password-hint" className="hint">{t('passwordHint')}</p>
    <p id="auth-error" role="alert">{state.error ? t(state.error) : ''}</p>
    <button disabled={pending}>{t(mode === 'sign-up' ? 'signUp' : 'signIn')}</button>
  </form>;
}

export function NoteForm({ locale }) {
  const t = useTranslations('App');
  const [state, action, pending] = useActionState(saveNote, {});
  return <form action={action} aria-busy={pending}>
    <input type="hidden" name="locale" value={locale} />
    <label htmlFor="body">{t('note')}</label><textarea id="body" name="body" required maxLength={500} rows={4} aria-invalid={state.error === 'required' || undefined} aria-describedby="note-status" />
    <button disabled={pending}>{t(pending ? 'saving' : 'save')}</button>
    <p id="note-status" role="status">{state.error ? t(state.error) : state.saved ? t('saved') : ''}</p>
  </form>;
}

export function SessionForm({ locale }) {
  const t = useTranslations('App');
  const [state, action, pending] = useActionState(revokeOtherSessions, {});
  return <form action={action}><input type="hidden" name="locale" value={locale} />
    <button disabled={pending}>{t('revoke')}</button><p role="status">{state.error ? t(state.error) : state.updated ? t('updated') : ''}</p>
  </form>;
}
