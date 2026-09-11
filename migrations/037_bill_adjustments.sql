-- Cerrar una cuenta que no cuadra, y dejar escrito por qué.
--
-- Hasta aquí una cuenta sólo salía de OPEN por dos caminos, y ninguno sirve
-- para lo que pasa de verdad en un comedor:
--
--   CLOSED  se pone sola cuando lo cobrado iguala **exactamente** lo debido.
--   VOID    sólo si no ha entrado un céntimo (`BILL_HAS_PAYMENTS` si entró).
--
-- Entre los dos queda un hueco por el que se cae media sala. Una mesa que paga
-- 2.000 de 2.330 y se va; una cortesía de la casa sobre una cuenta que ya tenía
-- dos cobros; un plato devuelto después de pagar; un cero de más al teclear.
-- En todos esos casos la cuenta no se puede cerrar **nunca**: anularla se
-- rechaza porque hay dinero, y quitarle líneas para cuadrarla se rechaza con
-- `TOTAL_BELOW_AMOUNT_PAID` en cuanto el total bajaría de lo cobrado. La mesa
-- se queda ocupada en el plano para siempre y su saldo, en el pendiente de
-- cobro del panel, también.
--
-- Esta tabla es la mitad que faltaba: **lo que se dejó de cobrar, con motivo y
-- con nombre**. `POST /bills/:id/settle` escribe una fila aquí y cierra la
-- cuenta con lo que de verdad entró.
--
-- **Por qué una tabla y no una columna en `bills`.** Porque esto no es un
-- atributo de la cuenta sino un hecho con autor y fecha: quién perdonó cuánto y
-- por qué. Una columna guarda la cifra y pierde las otras tres cosas, que son
-- justamente las que se miran cuando alguien pregunta por qué el turno cuadró
-- cincuenta mil bolívares por debajo.
--
-- **Y por qué no toca `amount_paid_ves`.** Lo cobrado es lo cobrado: sale del
-- libro de pagos y es lo que se compara contra el banco y contra la caja.
-- Sumar aquí un cobro que nadie hizo cuadraría la cuenta y descuadraría el
-- arqueo, que es peor. La cuenta queda cerrada con `amount_paid_ves <
-- total_due_ves`, que el CHECK ya permitía; la diferencia vive aquí.
--
-- Los tres motivos no son decoración: responden a preguntas distintas de un
-- dueño. `DISCOUNT` es una rebaja acordada, `COMP` es una cortesía de la casa
-- -- las dos son decisiones comerciales -- y `WRITE_OFF` es dinero que no se
-- va a cobrar. Un turno con muchos WRITE_OFF es un problema; uno con muchos
-- COMP es una política.

CREATE TABLE IF NOT EXISTS bill_adjustments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id        UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  -- Siempre positivo: es lo que se dejó de cobrar. El signo lo da el motivo,
  -- no la cifra, y una cifra que puede ser negativa es una resta que alguien
  -- hará dos veces.
  amount_ves     BIGINT NOT NULL CHECK (amount_ves > 0),
  reason         VARCHAR(20) NOT NULL CHECK (reason IN ('DISCOUNT', 'COMP', 'WRITE_OFF')),
  -- Opcional y corta. "Se fueron sin pagar" o "cumpleaños de la mesa 4": lo que
  -- haga falta para que dentro de un mes la cifra siga significando algo.
  note           VARCHAR(280),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una por cuenta. Cerrar es un acto único -- después la cuenta ya no está
-- abierta --, y dejarlo escrito aquí impide que dos toques a la vez escriban
-- dos ajustes por el mismo hueco.
CREATE UNIQUE INDEX IF NOT EXISTS bill_adjustments_bill_idx
  ON bill_adjustments (bill_id);

-- La consulta del panel: lo perdonado en el turno de este restaurante.
CREATE INDEX IF NOT EXISTS bill_adjustments_restaurant_idx
  ON bill_adjustments (restaurant_id, created_at);

COMMENT ON TABLE bill_adjustments IS
  'Lo que se dejó de cobrar al cerrar una cuenta, con motivo y autor. No es un pago: no toca amount_paid_ves ni entra en el arqueo.';
