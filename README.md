# Virtual Footer

Set rules to add markdown text to the bottom or top of files based on rules. This text get's rendered normally, including dataview blocks or Obsidian Bases. Your notes don't get modified or changed, the given markdown text is simply rendered "virtually". Rules can be applied to folders, tags or properties. The content to be included can be entered directly in the plugin settings, or come from a file in your vault.

This is especially useful if you have many files with the same dataview block. Instead of pasting the dataview codeblock into every note, you can simply add it with this plugin. This prevents unecessary file bloat, while also letting you easily change the code for all files at the same time.

## Features
- Works with Dataview, Datacore and native Obisidan Bases
- Lets you define rules using folderes, tags and properties
	- Rules can be set to include or exclude subfolders and subtags (recursive matching)
	- Multi-condition rules are possible, allowing you to define multiple conditions for one rule (using AND/OR)
- Lets you select wether the "virtual content" gets added as a footer (end of file), a header (below properties) or in the sidebar
	- Lets you choose if all sidebar "virtual content" gets added to the same sidebar tab, or if it should be shown in it's own tab
- Allows for "virtual content" to be defined in the plugin settings, or in a markdown file
- Rules can be enabled or disabled from the plugin settings

## Example use cases

### Universally defined dataview for showing authors works
I have a folder called "Authors" which contains a note on each author of media I've read/watched. I want to see what media the Author has made when I open the note, so I use the following dataview query to query that info from my media notes:

``````md
#### Made
```dataview
TABLE without ID
file.link AS "Name"
FROM "References/Media Thoughts"
WHERE contains(creator, this.file.link)
SORT file.link DESC
```
``````

Instead of having to add this to each file, I can simply add a rule to the folder "Authors" which contains the above text, and it will be automatically shown in each file.
I can do this with as many folders as I like.

![virtual-footer-screenshot](https://github.com/user-attachments/assets/1251ece2-ad92-4393-9284-6c51d3567b6b)

![image](https://github.com/user-attachments/assets/1caa8991-eec1-42a2-96da-ad5526acbc36)

### Customizable backlinks
Some users use Virtual Footer to sort their backlinks based on folder or tag.

### Displaying tags used in a file
Other users use Virtual Footer at the top of a file to show tags used in the body of their notes. Check out [this issue](https://github.com/Signynt/virtual-footer/issues/5#issuecomment-2919648582) for examples!

### Displaying related notes in your daily note
I use this dataviewjs to display notes which were created, modified on that day or reference my daily note.

![image](https://github.com/user-attachments/assets/cbd45a04-7ace-498b-bdd4-c025b8b71315)

`````md
```dataviewjs
const currentDate = dv.current().file.name; // Get the current journal note's date (YYYY-MM-DD)

// Helper function to extract the date part (YYYY-MM-DD) from a datetime string as a plain string
const extractDate = (datetime) => {
    if (!datetime) return "No date";
    if (typeof datetime === "string") {
        return datetime.split("T")[0]; // Split at "T" to extract the date
    }
    return "Invalid format"; // Fallback if not a string
};

const thoughts = dv.pages('"Thoughts"')
    .where(p => {
        const createdDate = p.created ? extractDate(String(p.created)) : null;
        const modifiedDate = p.modified ? extractDate(String(p.modified)) : null;
        return createdDate === currentDate || modifiedDate === currentDate;
    });

const wiki = dv.pages('"Wiki"')
    .where(p => {
        const createdDate = p.created ? extractDate(String(p.created)) : null;
        const modifiedDate = p.modified ? extractDate(String(p.modified)) : null;
        return createdDate === currentDate || modifiedDate === currentDate;
    });

const literatureNotes = dv.pages('"References/Literature"')
    .where(p => {
        const createdDate = p.created ? extractDate(String(p.created)) : null;
        const modifiedDate = p.modified ? extractDate(String(p.modified)) : null;
        return createdDate === currentDate || modifiedDate === currentDate;
    });

const mediaThoughts = dv.pages('"References/Media"')
    .where(p => {
        // Check only for files that explicitly link to the daily note
        const linksToCurrent = p.file.outlinks && p.file.outlinks.some(link => link.path === dv.current().file.path);
        return linksToCurrent;
    });

const mediaWatched = dv.pages('"References/Media"')
    .where(p => {
        const startedDate = p.started ? extractDate(String(p.started)) : null;
        const finishedDate = p.finished ? extractDate(String(p.finished)) : null;
        return startedDate === currentDate || finishedDate === currentDate;
    });

const relatedFiles = [...thoughts, ...mediaThoughts, ...mediaWatched, ...wiki, ...literatureNotes];

if (relatedFiles.length > 0) {
    dv.el("div", 
        `> [!related]+\n` + 
        relatedFiles.map(p => `> - ${p.file.link}`).join("\n")
    );
} else {
    dv.el("div", `> [!related]+\n> - No related files found.`);
}
```
`````

### Displaying dataview in the sidebar
You can also use Virtual Footer to display dataview (or anything else) in the sidebar. This is useful if you want to see the results of a dataview query without having to scroll to the bottom of the file.
Just select the "Sidebar" option in the settings, and use the "Open virtual content in sidebar" command.

![Untitled](https://github.com/user-attachments/assets/0fa7067a-596e-422b-b676-3f435fa1d49b)

## Limitations

Links in the markdown text work natively when in Reading mode, however they don't in Live Preview, so I've added a workaround that gets most functionality back. This means that `left click` works to open the link in the current tab, and `middle mouse` and `ctrl/cmd + left click` works to open the link in a new tab. Right click currently doesn't work.
