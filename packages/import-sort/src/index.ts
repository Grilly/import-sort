import * as assign from "core-js/library/fn/object/assign";
import * as findIndex from "core-js/library/fn/array/find-index";

import {IImport, IParser, NamedMember} from "import-sort-parser";
import {INamedMemberSorterFunction, ISorterFunction, IStyle} from "import-sort-style";

import StyleAPI from "./style/StyleAPI";

export interface ISortResult {
  code: string;
  changes: Array<ICodeChange>;
}

export interface ICodeChange {
  start: number;
  end: number;
  code: string;
  note?: string;
}

export default function importSort(
  code: string, rawParser: string | IParser, rawStyle: string | IStyle
): ISortResult {
  let parser: IParser | undefined;
  let style: IStyle;

  if (typeof rawParser === "string") {
    parser = require(rawParser);
  } else {
    parser = rawParser as IParser;
  }

  if (typeof rawStyle === "string") {
    style = require(rawStyle).default;
  } else {
    style = rawStyle as IStyle;
  }

  return sortImports(code, parser!, style);
}

export function sortImports(code: string, parser: IParser, style: IStyle): ISortResult {
  const items = addFallback(style)(StyleAPI);

  const buckets: Array<Array<IImport>> = items.map(() => []);

  const imports = parser.parseImports(code);

  if (imports.length === 0) {
    return {code, changes: []};
  }

  const changes: Array<ICodeChange> = [];

  // Fill buckets
  for (const imported of imports) {
    let sortedImport = imported;

    const index = findIndex(items, item => {
      sortedImport = sortNamedMembers(imported, item.sortNamedMembers);
      return !!item.match && item.match!(sortedImport);
    });

    if (index !== -1) {
      buckets[index].push(sortedImport);
    }
  }

  // Sort buckets
  buckets.forEach((bucket, index) => {
    const sort = items[index].sort;

    if (!sort) {
      return;
    }

    if (!Array.isArray(sort)) {
      bucket.sort(sort as ISorterFunction);
      return;
    }

    const sorters = sort as Array<ISorterFunction>;

    if (sorters.length === 0) {
      return;
    }

    const multiSort = (first: IImport, second: IImport): number => {
        let sorterIndex = 0;
        let comparison = 0;

        while (comparison === 0 && sorters[sorterIndex]) {
          comparison = sorters[sorterIndex](first, second);
          sorterIndex++;
        }

        return comparison;
    };

    bucket.sort(multiSort);
  });

  let importsCode = "";

  // Track if we need to insert a separator
  let separator = false;

  buckets.forEach((bucket, index) => {
    if (bucket.length > 0 && separator) {
      importsCode += "\n";
      separator = false;
    }

    bucket.forEach(imported => {
      // const sortedImport = sortNamedMembers(imported, items[index].sortNamedMembers);
      const importString = parser.formatImport(code, imported);
      importsCode += importString + "\n";
    });

    // Add separator but only when at least one import was already added
    if (items[index].separator && importsCode !== "") {
      separator = true;
    }
  });

  let sortedCode = code;

  // Remove imports
  imports.slice().reverse().forEach(imported => {
    let importEnd = imported.end;

    if (sortedCode.charAt(imported.end).match(/\s/)) {
      importEnd++;
    }

    changes.push({
      start: imported.start,
      end: importEnd,
      code: "",
      note: "import-remove",
    });

    sortedCode = sortedCode.slice(0, imported.start) + sortedCode.slice(importEnd, code.length);
  });

  const start = imports[0].start;

  // Split code at first original import
  let before = code.substring(0, start);
  let after = sortedCode.substring(start, sortedCode.length);

  let oldBeforeLength = before.length;
  let oldAfterLength = after.length;

  let beforeChange: ICodeChange | undefined;
  let afterChange: ICodeChange | undefined;

  // Collapse all whitespace into a single blank line
  before = before.replace(/\s+$/, match => {
    beforeChange = {
      start: start - match.length,
      end: start,
      code: "\n\n",
      note: "before-collapse",
    };

    return "\n\n";
  });

  // Collapse all whitespace into a single new line
  after = after.replace(/^\s+/, match => {
    afterChange = {
      start,
      end: start + match.length,
      code: "\n",
      note: "after-collapse",
    };

    return "\n";
  });

  // Remove all whitespace at the beginning of the code
  if (before.match(/^\s+$/)) {
    beforeChange = {
      start: start - oldBeforeLength,
      end: start,
      code: "",
      note: "before-trim",
    };

    before = "";
  }

  // Remove all whitespace at the end of the code
  if (after.match(/^\s+$/)) {
    afterChange = {
      start,
      end: start + oldAfterLength,
      code: "",
      note: "after-trim",
    };

    after = "";
  }

  if (afterChange) {
    changes.push(afterChange);
  }

  if (beforeChange) {
    changes.push(beforeChange);
  }

  const change = {
    start: before.length,
    end: before.length,
    code: importsCode,
    note: "imports",
  };

  changes.push(change);

  if (code === before + importsCode + after) {
    return {code, changes: []};
  }

  return {
    code: before + importsCode + after,
    changes,
  };
}

function sortNamedMembers(
  imported: IImport, rawSort?: INamedMemberSorterFunction | Array<INamedMemberSorterFunction>
): IImport {
  const sort = rawSort;

  if (!sort) {
    return imported;
  }

  if (!Array.isArray(sort)) {
    const sortedImport = assign({}, imported);
    sortedImport.namedMembers.sort(sort as INamedMemberSorterFunction);
    return sortedImport;
  }

  const sorters = sort as Array<INamedMemberSorterFunction>;

  if (sorters.length === 0) {
    return imported;
  }

  const multiSort = (first: NamedMember, second: NamedMember): number => {
      let sorterIndex = 0;
      let comparison = 0;

      while (comparison === 0 && sorters[sorterIndex]) {
        comparison = sorters[sorterIndex](first, second);
        sorterIndex++;
      }

      return comparison;
  };

  const sortedImport = assign({}, imported);
  sortedImport.namedMembers.sort(multiSort);

  return sortedImport;
}

export function applyChanges(code: string, changes: Array<ICodeChange>): string {
  let changedCode = code;

  for (const change of changes) {
    changedCode = changedCode.slice(0, change.start) + change.code + changedCode.slice(change.end, changedCode.length);
  }

  return changedCode;
}

function addFallback(style: IStyle): IStyle {
  return styleApi => {
    const items = [
      {separator: true},
      {match: styleApi.always},
    ];

    return style(styleApi).concat(items);
  };
}
