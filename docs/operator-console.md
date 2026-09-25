# Consola de Splite (`/admin`)

La consola es para el equipo de Splite, no para los restaurantes. Muestra todos los clientes con su plan, su precio, lo que deben y su actividad. Desde ella se cambian planes, se generan los cargos de cada periodo y se registran los pagos recibidos.

## Quién entra y cómo

- **Operadores**: son personas de Splite, en una tabla propia (`platform_operators`). No son usuarios de ningún restaurante.
- **Dos roles**:
  - `ADMIN` puede cambiar cosas.
  - `SUPPORT` solo mira.
- **Segundo factor obligatorio**: se entra con correo, contraseña de 14 o más caracteres y el código del autenticador. Un mismo código no vale dos veces.
- **Sesiones separadas**: la sesión de consola va firmada con otra clave y otra audiencia. Una sesión de restaurante no abre la consola, y una de consola no abre el panel de un restaurante. Dura 8 horas y no se renueva.
- **Desactivar a alguien** corta su acceso en la siguiente petición.
- **Rastro**: todo cambio queda en `operator_audit` con quién, cuándo y desde qué IP. El cambio y su apunte van en la misma transacción.

## Dar de alta al primer operador

Crear operadores solo se puede hacer desde la línea de comandos, dentro del servicio en Railway. La consola no puede crear cuentas de consola.

```sh
npm run operator -- create tu@correo.com ADMIN Tu Nombre
```

1. El comando imprime un **enlace de un solo uso** que caduca en 72 horas. Es una credencial: envíalo solo por un canal privado.
2. La persona abre el enlace.
3. Escanea el código QR con su autenticador (Google Authenticator, 1Password, Authy…).
4. Elige su contraseña.
5. Confirma con un código del autenticador.

Otros comandos:

```sh
npm run operator -- list
npm run operator -- reset tu@correo.com     # teléfono perdido: contraseña y autenticador nuevos
npm run operator -- disable tu@correo.com
npm run operator -- enable tu@correo.com
```

El secreto del autenticador no se guarda en la base de datos. Se deriva del secreto del servidor (`JWT_ACCESS_SECRET`), del id del operador y de una versión. Por eso `reset` basta para invalidar el autenticador anterior.

## Cobros

- **Precios**: se ponen en la consola, por plan y ciclo (mensual o anual), con fecha de inicio. Un precio nuevo no cambia los cargos ya hechos.
- **Precio pactado**: un restaurante puede tener un precio acordado que sustituye al de la lista.
- **Cargo**: es lo que un restaurante debe por un periodo, en dólares de referencia. **No es una factura fiscal.**
  - El periodo empieza donde terminó el anterior.
  - Vence 5 días después del inicio.
  - Un restaurante en prueba no tiene precio, así que no se le puede cobrar por error.
- **Pago**: se registra en bolívares o en dólares.
  - En bolívares hace falta la tasa. Si no se indica, se usa la del BCV del día; si no hay tasa del BCV, se rechaza el pago en vez de inventar una.
  - Lo que el pago descuenta del cargo queda fijado con esa tasa.
  - Si el pago cubre lo que falta, el cargo queda pagado.
- **Suspender o cancelar** una suscripción hoy solo queda registrado. Todavía no apaga nada en el producto: qué pierde un restaurante que no paga es una decisión pendiente.
