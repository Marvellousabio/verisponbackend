select t.id,
       t.reference,
       t.state,
       case
         when t.state in ('FUNDED', 'SELLER_PROCESSING', 'SHIPPED', 'DELIVERED', 'BUYER_INSPECTION',
                          'DELIVERY_FAILED', 'RETURN_IN_PROGRESS', 'DISPUTED', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED')
           then t.amount_kobo - t.refunded_kobo
         else 0
       end as expected_held,
       coalesce(sum(case
         when l.account = 'escrow_cash' and l.direction = 'C' then l.amount_kobo
         when l.account = 'escrow_cash' and l.direction = 'D' then -l.amount_kobo
         else 0
       end), 0) as posted_held
from transactions t
left join ledger_entries l on l.transaction_id = t.id
group by t.id, t.reference, t.state, t.amount_kobo, t.refunded_kobo
having case
         when t.state in ('FUNDED', 'SELLER_PROCESSING', 'SHIPPED', 'DELIVERED', 'BUYER_INSPECTION',
                          'DELIVERY_FAILED', 'RETURN_IN_PROGRESS', 'DISPUTED', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED')
           then t.amount_kobo - t.refunded_kobo
         else 0
       end <> coalesce(sum(case
         when l.account = 'escrow_cash' and l.direction = 'C' then l.amount_kobo
         when l.account = 'escrow_cash' and l.direction = 'D' then -l.amount_kobo
         else 0
       end), 0);

select t.id, t.reference, t.state,
       coalesce(sum(case
         when l.direction = 'C' then l.amount_kobo
         when l.direction = 'D' then -l.amount_kobo
       end), 0) as escrow_residual
from transactions t
join ledger_entries l on l.transaction_id = t.id and l.account = 'escrow_cash'
where t.state in ('RELEASED', 'COMPLETED', 'REFUNDED')
group by t.id, t.reference, t.state
having coalesce(sum(case
         when l.direction = 'C' then l.amount_kobo
         when l.direction = 'D' then -l.amount_kobo
       end), 0) <> 0;