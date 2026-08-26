/**
 * Variáveis CSS customizadas em `style`.
 *
 * O `CSSProperties` do React só admite propriedades conhecidas, e o produto
 * passa três variáveis para o CSS pelo `style` inline — é assim que o nível de
 * fala, a geometria da grade e a do palco atravessam de JS para CSS sem uma
 * folha de estilo gerada. A assinatura de índice restrita a `--` mantém o resto
 * da checagem de `style` intacta: um `colr` continua sendo erro.
 */
import 'react';

declare module 'react' {
  interface CSSProperties {
    [variavel: `--${string}`]: string | number | undefined;
  }
}
