/**
 * personContact.js — where a person's email and phone number go in a request
 * body, by OSDM version (#772).
 *
 * The booking puts them flat in `detail` (`detail.email`, deprecated later)
 * below 3.4, and in `detail.contact` (ContactDetail) from 3.4
 * (scenarioParser). The passenger update and the purchaser body always used
 * `detail.contact`: a 3.0.5 provider ignored it and kept the old values. Both
 * follow the booking's rule now. Pure: no `bru`.
 */

/** Whether a version takes email and phone in `detail.contact` (the booking's rule). */
const usesContactDetail = (osdmVersion) => Number.parseFloat(osdmVersion) >= 3.4;

/**
 * `detail` with its email and phone number in the place the version takes
 * them. A value under `contact` wins over a flat one (the update is put
 * there); an empty `contact` is left out.
 */
function withContactShape(detail, osdmVersion) {
  const d = detail && typeof detail === 'object' ? { ...detail } : {};
  const c = d.contact && typeof d.contact === 'object' ? d.contact : {};
  const values = {};
  for (const key of ['email', 'phoneNumber']) {
    const value = c[key] ?? d[key];
    if (value !== undefined) values[key] = value;
  }
  delete d.email;
  delete d.phoneNumber;
  const rest = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'email' && k !== 'phoneNumber'));
  delete d.contact;
  if (usesContactDetail(osdmVersion)) {
    const contact = { ...rest, ...values };
    if (Object.keys(contact).length > 0) d.contact = contact;
    return d;
  }
  if (Object.keys(rest).length > 0) d.contact = rest;
  return { ...d, ...values };
}

module.exports = { usesContactDetail, withContactShape };
