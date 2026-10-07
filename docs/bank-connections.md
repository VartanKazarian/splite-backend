# Conexiones con el banco

Cómo le llegan a Splite los movimientos de la cuenta de un restaurante, de cualquier banco, para confirmar solos los avisos de Pago Móvil.

## Qué hace Splite con un movimiento

1. Lo **normaliza**. De la referencia se quedan sólo los dígitos. El importe se pasa a céntimos, aceptando `1.234,56`, `1234.56` o `Bs 1.234,56`. Una fecha sin zona se lee como hora de Caracas. Lo que no se entiende se rechaza con un motivo y no se adivina.
2. Lo **guarda una sola vez**. El mismo restaurante, la misma referencia y el mismo importe cuentan como el mismo movimiento, así que mandarlo dos veces no tiene efecto.
3. Lo **compara con los avisos pendientes** con la misma regla que usaría un mesero:
   - Los últimos 8 o más dígitos de la referencia tienen que coincidir.
   - El importe tiene que ser exacto e incluir la propina.
   - Banco, teléfono y cédula se comparan sólo cuando los dos lados los traen.
   - Si dos avisos casan con el mismo movimiento, no se confirma ninguno y lo decide una persona.
4. **Confirma solo** el aviso únicamente si casó sin dudas y el dueño encendió la confirmación automática en esa conexión (viene apagada). Si no, lo deja **sugerido** en Pagos, para que el personal lo confirme con un toque.

Un movimiento respalda un aviso como mucho. Confirmado el aviso, sea a mano o por el banco, el movimiento queda gastado.

## Fuentes

| Tipo | Para qué | Quién la crea |
|---|---|---|
| `STATEMENT_IMPORT` | El estado de cuenta que el restaurante descarga de su banco (CSV o TXT) y sube desde Pagos. Funciona con todos los bancos, sin credenciales. | El dueño |
| `WEBHOOK` | Cualquier sistema que pueda hacer un POST firmado: un servicio de verificación (Pabilo, PagoFlash…), un reenviador de los correos del banco, un script propio. | El dueño |
| `MERCANTIL_P2C` | Las notificaciones de pago de Mercantil: el banco avisa a Splite de cada Pago Móvil que entra en la cuenta del restaurante, en el momento. | El dueño, con el RIF y la llave que le dio Mercantil |

Las APIs de otros bancos se añadirán como un tipo más cuando haya credenciales con las que probarlas. El resto no cambia.

## Notificaciones de Mercantil (P2C)

El «Servicio de Notificación de Pagos» de Mercantil (documento *Notificación webhook cliente*, vT7). Splite se afilia como **integrador**: el banco manda los pagos de todos los restaurantes a una sola URL, y cada mensaje dice de qué comercio es.

**La URL para el banco**, de pruebas y de producción, es la del API seguida de:

```
POST /api/v1/bank-inbound/mercantil
```

Cómo funciona:

1. El banco entrega a cada comercio una **llave** (la «MasterKey»), en una ceremonia con su personal de Seguridad de la Información. El dueño la escribe en el panel junto con el RIF del comercio. Se guarda sellada con `PAYMENT_CREDENTIALS_KEYS` y no vuelve a salir en ninguna respuesta, registro ni auditoría.
2. Cada pago llega como `{"data": "<base64>"}` con la cabecera `CompIdentif: J307243287`. El RIF dice qué conexión y su llave abre el mensaje: AES con una llave derivada por SHA-256 de la MasterKey.
3. Sólo se guarda un pago **recibido** (`tipo` R), **aprobado** (`codigo` 00) y **en bolívares**. Se guarda como cualquier otro movimiento y se compara con los avisos pendientes igual que los demás. Un pago enviado, rechazado o en otra moneda se contesta como recibido y no se guarda.
4. La respuesta es el sobre que espera el banco, con su `infoMsg` devuelto: `codigo` 0000 «Notificacion recibida con éxito!», u «Operación duplicada» si ya estaba. Un mensaje que se abre pero no se entiende (sin referencia, importe ilegible) recibe 200 con 9999 y queda anotado en la conexión, porque reintentarlo no lo arreglaría.
5. Un RIF sin conexión, una llave que no abre el mensaje o una IP fuera de `MERCANTIL_NOTIFY_ALLOWED_IPS` reciben el mismo **401**. El banco lo cuenta como fallido y reintenta hasta tres veces. Si es la llave, el panel lo muestra en la conexión.

Un RIF puede estar en una sola conexión activa de todo Splite: es la única forma de saber a qué restaurante va un mensaje. Para pasar de la llave de pruebas a la de producción, se cambia la llave en la misma conexión.

**Por confirmar con el banco.** El documento dice «sha256 con AES usando una MasterKey» y nada más. Splite usa el esquema del resto de las APIs de Mercantil: los primeros 16 bytes del SHA-256 de la llave, AES-128-ECB con relleno PKCS#7, en base64. Si el mensaje no abre así, prueba con los 32 bytes (AES-256). El primer mensaje de prueba del banco confirma cuál de los dos es.

## Enviar movimientos por webhook

Al crear una conexión `WEBHOOK`, Splite devuelve una **ruta** y un **secreto**. El secreto sale una sola vez. Si se pierde, se rota desde el panel y el anterior deja de valer.

```
POST /api/v1/bank-inbound/{connectionId}
Content-Type: application/json
X-Splite-Timestamp: 1790280000
X-Splite-Signature: sha256=<hex>
```

- `X-Splite-Timestamp` es la hora en segundos Unix. Con más de 5 minutos de diferencia se rechaza.
- `X-Splite-Signature` es `sha256=` seguido del HMAC-SHA256 en hexadecimal, calculado con el secreto sobre `"<timestamp>.<cuerpo>"`.
- El cuerpo que se firma son los **bytes exactos** que se envían. Si se vuelve a serializar el JSON después de firmar, la firma deja de valer.

Cuerpo, con hasta 500 movimientos por petición:

```json
{
  "movements": [
    {
      "reference": "001234567890",
      "amount": "1.234,56",
      "occurredAt": "2026-09-24T21:30:00-04:00",
      "phoneOrigin": "04141234567",
      "idOrigin": "V12345678",
      "bankCode": "0134",
      "description": "PAGO MOVIL RECIBIDO"
    }
  ]
}
```

Sólo `reference` y el importe son obligatorios. El importe puede ir como `amount` (texto) o como `amountMinor` (céntimos, sólo dígitos). Los débitos se rechazan: sólo cuentan los pagos recibidos.

Respuesta:

```json
{
  "received": 1, "inserted": 1, "duplicates": 0,
  "rejected": [],
  "matches": { "matched": 1, "mismatch": 0, "ambiguous": 0, "notFound": 2, "autoConfirmed": 0 }
}
```

Una conexión que no existe, una firma mala y una hora fuera de ventana responden todas el mismo `401`. Reintentar es seguro.

### Ejemplo en Node

```js
const crypto = require('crypto');

async function push({ baseUrl, connectionId, secret, movements }) {
  const body = JSON.stringify({ movements });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const res = await fetch(`${baseUrl}/api/v1/bank-inbound/${connectionId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-splite-timestamp': String(ts),
      'x-splite-signature': `sha256=${sig}`
    },
    body
  });
  return res.json();
}
```

### Ejemplo con curl

```sh
BODY='{"movements":[{"reference":"001234567890","amount":"110,00"}]}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$API/api/v1/bank-inbound/$CONNECTION_ID" \
  -H 'content-type: application/json' \
  -H "x-splite-timestamp: $TS" \
  -H "x-splite-signature: sha256=$SIG" \
  --data "$BODY"
```

## Seguridad

- **La llave de Mercantil, sellada.** Es el único secreto que guarda una conexión, porque la entrega el banco y no se puede derivar. Va cifrada con AES-256-GCM (`PAYMENT_CREDENTIALS_KEYS`), como las credenciales de las APIs de pago, y ninguna respuesta la devuelve: el panel sólo sabe si la hay. El contenido de una notificación (cédula y teléfono del pagador) no se escribe en los registros.
- **Ningún secreto guardado en un `WEBHOOK`.** La firma se deriva del `WEBHOOK_SECRET` del servidor, del id de la conexión y de su versión. Una copia de la base no permite firmar nada, y rotar el secreto es subir la versión.
- **Replay acotado.** La hora va dentro de lo firmado y se acepta con 5 minutos de margen. Repetir una petición dentro de ese margen no hace nada, porque los movimientos son idempotentes.
- **Permisos por rol.** Crear conexiones, rotar la firma y encender la confirmación automática es sólo del dueño. Subir estados de cuenta y ver movimientos, también del encargado y de caja.
- **Todo atado al restaurante.** Un movimiento de una conexión sólo puede confirmar avisos del restaurante dueño de esa conexión.
- **Registro de quién confirmó.** Una confirmación hecha por el banco queda registrada como tal en el historial del pago (`actor_type = PROVIDER`) y en la auditoría.
