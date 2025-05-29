# Virtual Footer

Set rules to add markdown text to the bottom (or top) of each file in a folder, or based on a tag present in them. This text get's rendered normally, including dataview blocks.
Your notes don't get modified or changed, the given markdown text is simply rendered "virtually".

This is especially useful if you have many files with the same dataview block. Instead of pasting the datview codeblock into every note, you can simply add it with this plugin.
This prevents unecessary bloat, while also letting you easily change the code for all files at the same time.

## Example use cases

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

![image](https://github.com/user-attachments/assets/b8f3cc76-ae57-478f-898b-b54afc63ff07)

![image](https://github.com/user-attachments/assets/1caa8991-eec1-42a2-96da-ad5526acbc36)


## Limitations

Links in the markdown text work natively when in Reading mode, however they don't in Live Preview, so I've added a workaround that gets most functionality back. This means that `left click` works to open the link in the current tab, and `middle mouse` and `ctrl/cmd + left click` works to open the link in a new tab. Right click currently doesn't work.
