import type { Ipc, Settings } from '../ipc';

/**
 * Mount the first-run profile setup modal. Matches wireframe 02.
 *
 * On Save, fetches the current settings, merges in the new
 * `profile.display_name` and `profile.color`, and persists with
 * `ipc.setSettings(merged)`.
 */
export async function mountProfileSetup(root: HTMLElement, ipc: Ipc): Promise<void> {
  root.replaceChildren();

  const view = document.createElement('section');
  view.setAttribute('data-view', 'profile-setup');

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('h2');
  title.textContent = 'Set up your profile';
  modal.appendChild(title);

  const blurb = document.createElement('p');
  blurb.textContent =
    "Your name and color appear next to comments you write. They're stored only on this computer — change them anytime in Settings → Profile.";
  modal.appendChild(blurb);

  // Read current settings up front so we preserve every other field on save.
  const current: Settings = await ipc.getSettings();

  // Name row
  const nameRow = document.createElement('div');
  nameRow.className = 'row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Display name';
  nameLabel.setAttribute('for', 'profile-name');
  const nameInput = document.createElement('input');
  nameInput.id = 'profile-name';
  nameInput.type = 'text';
  nameInput.setAttribute('data-test', 'profile-name');
  nameInput.value = current.profile.display_name ?? '';
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameInput);
  modal.appendChild(nameRow);

  // Color row — color picker is a native <input type="color">. Wireframe 02
  // shows a swatch grid; we surface the same affordance with a single input
  // (the swatch grid is a visual nicety we can layer on later without
  // changing the persistence contract).
  const colorRow = document.createElement('div');
  colorRow.className = 'row';
  const colorLabel = document.createElement('label');
  colorLabel.textContent = 'Avatar color';
  colorLabel.setAttribute('for', 'profile-color');
  const colorInput = document.createElement('input');
  colorInput.id = 'profile-color';
  colorInput.type = 'color';
  colorInput.setAttribute('data-test', 'profile-color');
  colorInput.value = current.profile.color || '#888888';
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorInput);
  modal.appendChild(colorRow);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const skip = document.createElement('button');
  skip.setAttribute('data-action', 'skip-profile');
  skip.textContent = 'Skip for now';
  skip.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:profile-skipped'));
  });
  actions.appendChild(skip);

  const save = document.createElement('button');
  save.setAttribute('data-action', 'save-profile');
  save.className = 'primary';
  save.textContent = 'Save profile';
  save.addEventListener('click', async () => {
    const merged: Settings = {
      ...current,
      profile: {
        ...current.profile,
        display_name: nameInput.value,
        color: colorInput.value,
      },
    };
    await ipc.setSettings(merged);
    document.dispatchEvent(new CustomEvent('mdviewer:profile-saved'));
  });
  actions.appendChild(save);
  modal.appendChild(actions);

  view.appendChild(modal);
  root.appendChild(view);
}
