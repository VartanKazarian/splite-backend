-- Reservas de pago: «Ana está pagando 100 Bs».
--
-- Un Pago Móvil sale del banco del comensal sin pasar por Splite, que sólo se
-- entera cuando el comensal vuelve y escribe la referencia. Para cuando la
-- cuenta se cierra, la segunda transferencia ya está hecha. Lo único que Splite
-- controla es lo que ve cada uno *antes* de ir a su banco, así que al pulsar
-- «Pagar» el comensal reserva lo que va a transferir durante unos minutos, y
-- los demás de la mesa ven esa parte reservada y no pueden empezar a pagarla.
--
-- Una reserva está activa mientras no se haya soltado, no se haya usado para un
-- aviso y no haya caducado. Caducar no necesita a nadie: se lee expires_at.
-- Nunca bloquea un aviso: quien ya transfirió avisa igual.
CREATE TABLE IF NOT EXISTS payment_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL,
  guest_session_id UUID NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
  -- La parte del reparto que se va a pagar, si se paga una parte.
  split_participant_id UUID,
  amount_ves BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- El comensal volvió atrás o cambió de importe.
  released_at TIMESTAMPTZ,
  -- El aviso que la usó. Desde ahí cuenta como pago en verificación.
  consumed_by_payment_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT payment_holds_amount_positive CHECK (amount_ves > 0),
  CONSTRAINT payment_holds_bill_fk
    FOREIGN KEY (bill_id, restaurant_id) REFERENCES bills (id, restaurant_id) ON DELETE CASCADE,
  CONSTRAINT payment_holds_share_fk
    FOREIGN KEY (split_participant_id, restaurant_id)
    REFERENCES bill_split_participants (id, restaurant_id) ON DELETE CASCADE,
  CONSTRAINT payment_holds_payment_fk
    FOREIGN KEY (consumed_by_payment_id) REFERENCES payments (id) ON DELETE SET NULL
);

-- Una reserva viva por comensal y cuenta: volver a pulsar «Pagar» la cambia,
-- no apila otra.
CREATE UNIQUE INDEX IF NOT EXISTS payment_holds_one_live_per_session
  ON payment_holds (bill_id, guest_session_id)
  WHERE released_at IS NULL AND consumed_by_payment_id IS NULL;

-- Lo que se lee bajo el bloqueo de la cuenta en cada reserva y cada vista.
CREATE INDEX IF NOT EXISTS payment_holds_bill_live_idx
  ON payment_holds (bill_id, expires_at)
  WHERE released_at IS NULL AND consumed_by_payment_id IS NULL;

COMMENT ON TABLE payment_holds IS
  'Short reservation a diner takes before leaving for their banking app, so tablemates cannot start paying the same balance. Advisory: never blocks a declaration of money already sent.';
