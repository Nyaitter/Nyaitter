const MAX_NAME_LENGTH = 80;
const MAX_TEXT_LENGTH = 2_000;
const MAX_IMAGE_DATA_LENGTH = 2_500_000;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function cleanImageData(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_LENGTH) return null;
  return IMAGE_DATA_URL_PATTERN.test(value) ? value.replace(/\s/g, '') : null;
}

/**
 * Maps only benign, presentation-oriented external profile fields.
 * Privilege, identity and local preference fields are deliberately ignored.
 */
function normalizeExternalProfile(profile = {}, fallbackName = '') {
  const displayName = cleanText(profile.name || profile.display_name, MAX_NAME_LENGTH) || fallbackName;
  const bio = cleanText(profile.me || profile.bio || profile.description, MAX_TEXT_LENGTH);
  const iconData = cleanImageData(profile.icon_data || profile.avatar_data || profile.avatar);
  const headerImage = cleanImageData(profile.header_image || profile.header_data || profile.banner_data);

  return {
    name: displayName,
    me: bio,
    bio,
    icon_data: iconData,
    header_image: headerImage,
    // Keep only the data actually used for the first local profile creation.
    // Do not import admin, verification, settings, relationships, tokens or URLs.
    external_profile: {
      name: displayName,
      me: bio,
      icon_data: iconData,
      header_image: headerImage,
    },
  };
}

module.exports = {
  normalizeExternalProfile,
};
