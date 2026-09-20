const crypto = require('node:crypto');

/**
 * Un RIF para el fixture que no pueda chocar con el de otro restaurante.
 *
 * `restaurants_rif_unique_idx` es único en toda la tabla -- no por fichero --,
 * y el runner arranca **un proceso por fichero de pruebas**. La versión
 * anterior mezclaba el reloj con un contador del módulo, y el contador vuelve a
 * empezar en cada proceso: dos ficheros que crearan un restaurante dentro del
 * mismo milisegundo generaban exactamente el mismo RIF. Medido, no deducido:
 * con aquella fórmula, dos instancias recién cargadas del módulo con el reloj
 * en el mismo valor colisionaban las 1000 veces de 1000.
 *
 * Eso tumbó el `before` de `billItemTax` en main con un 23505, dejó seis
 * pruebas canceladas y la vuelta en rojo -- y como Railway sólo despliega un
 * commit cuyos checks pasan, bloqueó un despliegue que no tenía nada que ver.
 * El código que se desplegaba estaba bien; lo que falló fue el andamio.
 *
 * Así que ni reloj ni contador de módulo: nueve dígitos al azar, que no
 * dependen de que dos procesos no coincidan en el tiempo. Va en su propio
 * fichero, sin la base de datos detrás, para poder comprobarlo sin ella.
 */
function newRif() {
  return `J${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

module.exports = { newRif };
