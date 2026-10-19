import Anthropic from '@anthropic-ai/sdk';

export const IN = ['Sales', 'Services', 'Revenue before tracking', 'Other income'];
export const OUT = ['Payroll', 'Rent', 'Software', 'Marketing', 'Travel', 'Meals', 'Supplies', 'Taxes and fees', 'Cost of goods', 'Expenses before tracking', 'Other expense'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_receipt', 'kind', 'vendor', 'date', 'total', 'category'],
  properties: {
    is_receipt: { type: 'boolean', description: 'false if the image is not a receipt or invoice' },
    kind: { type: 'string', enum: ['expense', 'sale'], description: '"sale" only when the receipt shows the company selling to a customer' },
    vendor: { type: 'string', description: 'Store or supplier name; the customer name for a sale' },
    date: { type: ['string', 'null'], description: 'Purchase date as YYYY-MM-DD, or null if unreadable' },
    total: { type: 'number', description: 'Final amount paid, including tax and tip' },
    category: { type: 'string', enum: [...OUT, ...IN] },
  },
};

let client;
export const receiptsEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export async function readReceipt({ data, mediaType }) {
  client ||= new Anthropic();
  const response = await client.beta.messages.create({
    model: process.env.RECEIPT_MODEL || 'claude-opus-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: 'Read this photo for a small-business ledger. Extract the vendor, purchase date, final total and the best-fitting category. Use "sale" only if this is the company\'s own sales receipt to a customer.' },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('This image could not be read.'), { status: 422 });
  const text = response.content.find(b => b.type === 'text')?.text;
  const r = JSON.parse(text);
  if (!r.is_receipt) throw Object.assign(new Error('That photo does not look like a receipt.'), { status: 422 });
  const sale = r.kind === 'sale';
  const cats = sale ? IN : OUT;
  return {
    type: sale ? 'in' : 'out',
    description: String(r.vendor || 'Receipt').slice(0, 120),
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : null,
    amount: Math.abs(Number(r.total)) || 0,
    category: cats.includes(r.category) ? r.category : sale ? 'Sales' : 'Other expense',
  };
}
