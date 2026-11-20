-- La propina que la mesa trae marcada, la elige el restaurante.
--
-- Hasta aquí era un 10 % fijo en la pantalla del comensal, encima del cargo
-- por servicio. Si eso encaja con la costumbre del local -- o si lo correcto es
-- que nadie vea nada marcado cuando ya cobra un 10 % de servicio -- lo sabe el
-- restaurante, no nosotros. Así que es un ajuste suyo.
--
-- Las mismas cuatro opciones que tiene la fila de botones del comensal: un
-- valor que no corresponde a ningún botón no podría salir marcado. El 10 % de
-- partida conserva lo que ya ve hoy cada mesa hasta que el dueño lo cambie.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS default_tip_pct SMALLINT NOT NULL DEFAULT 10
    CONSTRAINT restaurants_default_tip_pct_check CHECK (default_tip_pct IN (0, 10, 15, 20));
