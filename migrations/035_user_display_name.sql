-- Cómo se llama quien entra.
--
-- `users` guardaba correo, rol y contraseña, y nada más. El panel saluda a
-- quien abre el turno, y sin un nombre lo único que quedaba era deducirlo de la
-- parte del correo anterior a la arroba: "gerencia@casa72.com" saludaba a
-- "Gerencia". Sirve para salir del paso, no para un producto.
--
-- Opcional a propósito. Nadie tiene que rellenarlo para trabajar, y una cuenta
-- que ya existe sigue funcionando sin tocarla: mientras esté vacío se sigue
-- usando el correo, que es lo que se hacía hasta ahora.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Ni cadena vacía ni espacios: o hay nombre o es NULL. Sin esto, "guardar" con
-- el campo en blanco deja un nombre que existe, mide cero y saluda a nadie.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_not_blank;
ALTER TABLE users ADD CONSTRAINT users_display_name_not_blank
  CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 80);
