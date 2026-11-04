/** Finds the WhatsApp number of a customer or supplier in ERPNext. */
import type { ErpNextClient } from './client.js';

export type PartyType = 'Customer' | 'Supplier';

export interface PartyPhone {
  /** The number exactly as typed in ERPNext. */
  raw: string;
  /** Where we found it, e.g. "Contact Ali Hassan (mobile)". */
  source: string;
}

interface ContactRow {
  name: string;
  mobile_no?: string;
  phone?: string;
  is_primary_contact?: number;
  first_name?: string;
}

/**
 * Lookup order:
 *  1. the custom WhatsApp field on the Customer/Supplier (if configured)
 *  2. the contact mobile picked on the invoice
 *  3. the Customer/Supplier "mobile_no" (primary contact)
 *  4. any linked Contact: primary first, mobile before phone
 */
export async function findPartyPhone(
  erp: ErpNextClient,
  partyType: PartyType,
  party: string,
  invoice: Record<string, unknown>,
  whatsappField = '',
): Promise<PartyPhone | null> {
  const partyDoc = await erp.getDoc<Record<string, unknown>>(partyType, party).catch(() => ({}) as Record<string, unknown>);

  const field = whatsappField.trim();
  if (field && typeof partyDoc[field] === 'string' && (partyDoc[field] as string).trim()) {
    return { raw: String(partyDoc[field]).trim(), source: `${partyType} field "${field}"` };
  }

  const invoiceMobile = String(invoice.contact_mobile ?? '').trim();
  if (invoiceMobile) return { raw: invoiceMobile, source: `invoice contact${invoice.contact_person ? ` ${invoice.contact_person}` : ''}` };

  const partyMobile = String(partyDoc.mobile_no ?? '').trim();
  if (partyMobile) return { raw: partyMobile, source: `${partyType} mobile number` };

  const contacts = await erp
    .getList<ContactRow>('Contact', {
      fields: ['name', 'mobile_no', 'phone', 'is_primary_contact', 'first_name'],
      filters: [
        ['Dynamic Link', 'link_doctype', '=', partyType],
        ['Dynamic Link', 'link_name', '=', party],
      ],
      limit: 50,
    })
    .catch(() => [] as ContactRow[]);

  const sorted = [...contacts].sort((a, b) => (b.is_primary_contact ?? 0) - (a.is_primary_contact ?? 0));
  for (const contact of sorted) {
    if (contact.mobile_no?.trim()) return { raw: contact.mobile_no.trim(), source: `Contact ${contact.name} (mobile)` };
  }
  for (const contact of sorted) {
    if (contact.phone?.trim()) return { raw: contact.phone.trim(), source: `Contact ${contact.name} (phone)` };
  }
  return null;
}
