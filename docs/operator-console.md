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

### Desde el navegador (sin entrar al servidor)

Sirve, por ejemplo, desde el teléfono.

1. En Railway, en el servicio `splite-backend`, abre Variables y añade `OPERATOR_BOOTSTRAP_TOKEN`. Pon como valor una frase larga que solo sepas tú, de 24 caracteres o más, por ejemplo una oración entera. Railway volverá a desplegar el servicio.
2. Abre `https://splite.lovable.app/admin/alta`, entra en «Primer acceso» y escribe esa frase, tu correo y tu nombre.
3. Sigue el alta normal: escanea el QR con el autenticador, elige tu contraseña y escribe el código.

Esto solo funciona **mientras no exista ningún operador**. El primero que se crea lo apaga para siempre, aunque la variable siga puesta; aun así, puedes borrarla después. Cualquier fallo responde igual (404), así que la respuesta no revela si la frase está puesta ni si ya hay operadores.

### Desde la línea de comandos

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

**Ojo:** si algún día se rota `JWT_ACCESS_SECRET`, cambian también todos los autenticadores de la consola. Habría que hacer `reset` a cada operador.

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

## Segunda vuelta: lo que corre solo

- **Precios de salida.** STARTER 9 $, PRO 29 $ y ENTERPRISE 59 $ al mes, desde el 25/09/2026 (migración 051). Se cambian en la consola, en Precios.
- **Renovación nocturna** (`npm run billing`, dentro de `npm run maintenance`).
  - Cuando termina un periodo, genera el cargo del siguiente, con el precio de ese día.
  - Solo renueva a quien ya se le empezó a cobrar: el primer cargo lo genera una persona desde la consola.
  - No renueva pruebas, suspendidos ni cancelados.
- **Recordatorios por correo al dueño.**
  - Hay tres por cargo, cada uno una sola vez: al generarse, al vencer y a los 7 días de vencido.
  - Un correo que falla se reintenta la noche siguiente.
  - Llevan el monto en $ y en Bs a la tasa BCV del día, y los datos de cobro de Splite.
- **Datos de cobro de Splite** (a dónde pagan los restaurantes): se ponen en la consola, en Precios. Sin ellos, los recordatorios salen sin la sección «Puedes pagar a».

## «Ya pagué»

- En Configuración → Suscripción, el dueño o el encargado ve su plan, lo que debe (en $ y en Bs a la tasa de hoy) y a dónde pagar. Desde ahí avisa de un pago.
- **El aviso no es un pago.** Queda pendiente en Cobros de la consola, y al equipo le llega un correo a `ONBOARDING_TEAM_EMAIL`.
- **Confirmar** registra el pago de verdad, a la tasa que se indique o a la del BCV de hoy.
- **Rechazar** exige un motivo, y el restaurante lo ve.
- La misma referencia no se puede avisar dos veces, salvo que se rechazara.

## Qué pasa si no paga

- **Nada se corta solo.** Un cargo vencido solo manda recordatorios y enseña un aviso en el panel del restaurante.
- **Suspender o cancelar** la suscripción desde la consola es una decisión de una persona. Su único efecto: **no se pueden abrir cuentas nuevas** (`403 SUBSCRIPTION_SUSPENDED`).
- Las mesas que ya tienen cuenta siguen pidiendo, dividiendo y pagando: un comensal nunca se queda sin poder pagar.
- Al reactivar, todo vuelve a funcionar.
- **Una prueba que termina** tampoco corta nada: sale como «Prueba vencida» en Clientes para que alguien llame.
