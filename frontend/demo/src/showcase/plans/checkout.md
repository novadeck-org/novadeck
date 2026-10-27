# Checkout flow

Replace the single-page checkout with three steps (cart, address, payment) that keep their state across reloads and fail softly when the payment provider is slow.

## Context

Today `src/checkout/Checkout.tsx` renders every field at once and posts the whole order on submit. Support sees two kinds of complaint: people lose a filled form when the page reloads, and a timeout from the provider shows a blank error. The cart summary is also computed twice, once in the page and once in `api/orders.ts`, and the two disagree on rounding.

## Steps

1. **Cart summary.** Move the totals into `src/cart/totals.ts` as one pure function, used by `CartSummary.tsx` and by `api/orders.ts`, so both round the same way (half-even, in cents).
2. **Address step.** A form in `src/checkout/AddressStep.tsx` with the fields the shipping API needs. It validates on blur, keeps a draft in `sessionStorage` and restores it on reload.
3. **Payment step, behind a provider interface.** `src/payments/provider.ts` names what checkout needs (`authorize`, `capture`, `void`); `stripe.ts` implements it and `fake.ts` serves tests and the preview. Checkout never imports Stripe directly.
4. **Order of steps.** A small reducer in `src/checkout/flow.ts` decides which step shows and what going back keeps. The URL carries the step (`/checkout/address`), so the back button works.
5. **Slow provider.** `authorize` times out after 10 s with a typed error; the payment step says the card wasn't charged and offers to try again, instead of the blank page.
6. **Copy.** The step titles, errors and the confirmation follow `docs/checkout-copy.md`.

## Files

| File                           | Change                                 |
| ------------------------------ | -------------------------------------- |
| `src/cart/totals.ts`           | New: the one place totals are computed |
| `src/cart/CartSummary.tsx`     | Uses `totals`                          |
| `src/checkout/Checkout.tsx`    | Becomes the shell that shows each step |
| `src/checkout/AddressStep.tsx` | New                                    |
| `src/checkout/PaymentStep.tsx` | New                                    |
| `src/checkout/flow.ts`         | New: the step reducer                  |
| `src/payments/provider.ts`     | New: the interface                     |
| `src/payments/stripe.ts`       | Moves the Stripe calls here            |
| `api/orders.ts`                | Uses `totals`, rejects a mismatch      |

## The provider interface

```ts
export type PaymentProvider = {
  authorize: (order: OrderTotals, card: CardToken) => Promise<Authorization>
  capture: (authorization: Authorization) => Promise<Receipt>
  void: (authorization: Authorization) => Promise<void>
}
```

## Tests

- `totals.test.ts`: rounding at the half cent, discounts, an empty cart.
- `flow.test.ts`: every step's next and back, a reload in the middle.
- `e2e/checkout.spec.ts`: a whole order on the fake provider, and the slow-provider path with a 10 s timeout faked.

## Risks

- **Rounding change.** Orders already placed keep their stored totals; only new orders use `totals`. I'll compare a week of past orders against the new function before switching.
- **Draft in sessionStorage** holds the address only, never card data.
- **Stripe's webhook** still points at `api/orders.ts`; its payload doesn't change.

## Out of scope

Saved addresses, Apple Pay and a guest-checkout toggle: each needs its own design pass.
