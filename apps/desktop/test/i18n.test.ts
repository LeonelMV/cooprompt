import { describe, expect, it } from 'vitest';
import { keyboardShortcuts, translate, translateMessage } from '../src/shared/i18n.ts';

describe('i18n', () => {
  it('keeps English as the source language and falls back to it', () => {
    expect(translate('en', 'New chat')).toBe('New chat');
    expect(translate('es', 'New chat')).toBe('Nuevo chat');
    expect(translate('es', 'Not translated yet')).toBe('Not translated yet');
    expect(translate('es', 'Hi, {name}', { name: 'Ana' })).toBe('Hola, Ana');
  });

  it('localizes filled messages coming from the server or other participants', () => {
    expect(translateMessage('es', 'Ana Pérez joined the chat')).toBe('Ana Pérez se unió al chat');
    expect(translateMessage('es', "The automation's computer, Studio PC, was not connected")).toBe('La computadora de la automatización, Studio PC, no estaba conectada');
    expect(translateMessage('es', 'Leo invited tomas@acme.com')).toBe('Leo invitó a tomas@acme.com');
    expect(translateMessage('es', 'Cancelled by Leo')).toBe('Cancelado por Leo');
    expect(translateMessage('es', 'Wrong email or password')).toBe('Email o contraseña incorrectos');
    expect(translateMessage('es', 'Retrying the model call (2/10)…')).toBe('Reintentando la llamada al modelo (2/10)…');
    expect(translateMessage('es', 'ENOENT: no such file or directory')).toBe('ENOENT: no such file or directory');
    expect(translateMessage('en', 'Ana Pérez joined the chat')).toBe('Ana Pérez joined the chat');
  });

  it('shows the correct keyboard shortcuts for the platform', () => {
    expect(keyboardShortcuts('Send: ⌘↩ · Team: ⇧⌘E', true)).toBe('Send: ⌘↩ · Team: ⇧⌘E');
    expect(keyboardShortcuts('Enviar: ⌘↩ · Equipo: ⇧⌘E', false)).toBe('Enviar: Ctrl+Enter · Equipo: Ctrl+Shift+E');
  });
});
