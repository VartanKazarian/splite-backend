-- El domicilio del local, para el encabezado del recibo.
--
-- Un recibo que alguien se lleva tiene que decir de dónde salió, y hasta ahora
-- de un restaurante sólo se sabían el nombre y el RIF. Con eso el encabezado es
-- una línea suelta: no sirve para reclamar, ni para justificar un gasto, ni
-- para encontrar el sitio dos semanas después.
--
-- Nullable y sin defecto, por la misma razón que el RIF lo es: los restaurantes
-- que ya existen no tienen dirección registrada, y ponerles una inventada sería
-- peor que dejar constancia de que no la sabemos. El recibo la imprime cuando
-- está y se calla cuando no, en vez de enseñar un hueco.
--
-- VARCHAR(200) porque es una dirección de una o dos líneas para un encabezado,
-- no un campo postal estructurado. Si algún día hace falta separarla en calle,
-- ciudad y estado, eso es otra migración y otro formulario.

BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS fiscal_address VARCHAR(200);

COMMENT ON COLUMN restaurants.fiscal_address IS
  'Domicilio del local tal y como se imprime en el encabezado del recibo. '
  'Nulo cuando no se ha registrado: el recibo lo omite en vez de inventarlo.';

COMMIT;
